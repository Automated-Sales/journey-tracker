import { Identity, Touchpoint, isIdentified } from "../db";
import { buildAttributionSummary } from "./attribution";
import { deepLinkForPerson } from "./pipedrive";

/**
 * Pure CSV helpers for the dashboard's "Download CSV" buttons — kept
 * separate from portal-summary.ts because that module caps its output
 * (top 25 recent prospects, top 10 campaigns) for what's reasonable to
 * render as HTML; an export should include everything, uncapped. No I/O
 * here (same testable-pure-function pattern as buildAttributionSummary
 * and buildPortalSummary) — see verify-portal.ts for the tests.
 */

// Excel (and most spreadsheet tools) needs a value quoted whenever it
// contains the delimiter, a quote, or a newline — and any embedded quote
// doubled. Values are also prefixed to defend against "CSV injection"
// (a cell starting with =, +, -, or @ being interpreted as a formula by
// Excel/Sheets when the file is opened) by prefixing a leading apostrophe,
// which every spreadsheet app treats as "force text" and never displays.
function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  // \r\n is the CSV spec's own line ending and what Excel expects —
  // \n-only files open fine in most tools but Excel on Windows has a
  // long history of mis-rendering them as one giant first line.
  return lines.join("\r\n") + "\r\n";
}

/**
 * `companyDomain` is the tenant's Pipedrive company domain (see
 * routes/portal.ts's export route, which is the only caller and passes
 * `tenant.pipedriveCompanyDomain`) — needed to build a clickable
 * Pipedrive URL per row, the CSV equivalent of the dashboard table's
 * Pipedrive column link. Still a pure function: this is just a plain
 * string input, no I/O happens in here.
 */
export function buildProspectsCsv(
  identities: Identity[],
  touchpoints: Touchpoint[],
  companyDomain: string | null = null,
  includeAnonymous: boolean = true
): string {
  const byIdentity = new Map<string, Touchpoint[]>();
  for (const tp of touchpoints) {
    if (!tp.identityId) continue;
    const list = byIdentity.get(tp.identityId) ?? [];
    list.push(tp);
    byIdentity.set(tp.identityId, list);
  }

  // Most-recently-seen first, matching the dashboard table's own order —
  // sorted here on the identities themselves (not the built rows) so this
  // can never drift out of sync with a hardcoded row-array column index
  // the way `rows.sort((a, b) => ... b[9] ...)` would the moment a column
  // gets added, removed, or reordered below.
  const sortedIdentities = identities.slice().sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());

  const rows: (string | number | null)[][] = [];
  for (const identity of sortedIdentities) {
    // Matches the dashboard table's "identified" definition exactly (see
    // db.ts's isIdentified) — same check, so the CSV and the on-screen
    // toggle never disagree about which rows count as anonymous.
    if (!includeAnonymous && !isIdentified(identity)) continue;
    const tps = (byIdentity.get(identity.id) ?? []).slice().sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const summary = buildAttributionSummary(tps);
    if (!summary) continue;

    rows.push([
      identity.email || identity.name || identity.phone || "(anonymous)",
      summary.firstTouchChannel,
      summary.firstTouchSource,
      summary.firstTouchMedium ?? "",
      summary.firstTouchCampaign ?? "",
      summary.firstTouchTerm ?? "",
      summary.firstTouchContent ?? "",
      summary.firstTouchDate,
      summary.firstTouchReferrer ?? "",
      summary.firstTouchLandingPage ?? "",
      summary.firstTouchGclid ?? "",
      summary.firstTouchFbclid ?? "",
      summary.firstTouchMsclkid ?? "",
      summary.lastTouchChannel,
      summary.lastTouchSource,
      summary.lastTouchMedium ?? "",
      summary.lastTouchCampaign ?? "",
      summary.lastTouchTerm ?? "",
      summary.lastTouchContent ?? "",
      summary.lastTouchDate,
      summary.lastTouchReferrer ?? "",
      summary.lastTouchLandingPage ?? "",
      summary.lastTouchGclid ?? "",
      summary.lastTouchFbclid ?? "",
      summary.lastTouchMsclkid ?? "",
      summary.touchpointCount,
      identity.leadToDealTouchpoints ?? "",
      identity.dealToWonTouchpoints ?? "",
      identity.firstSeenAt.toISOString(),
      identity.lastSeenAt.toISOString(),
      identity.pipedrivePersonId ?? "",
      identity.pipedrivePersonId ? deepLinkForPerson(companyDomain, identity.pipedrivePersonId) ?? "" : "",
    ]);
  }

  return toCsv(
    [
      "Contact",
      "First touch channel",
      "First touch source",
      "First touch medium",
      "First touch campaign",
      "First touch term",
      "First touch content",
      "First touch date",
      "First touch referrer",
      "First touch landing page",
      "First touch GCLID",
      "First touch FBCLID",
      "First touch MSCLKID",
      "Last touch channel",
      "Last touch source",
      "Last touch medium",
      "Last touch campaign",
      "Last touch term",
      "Last touch content",
      "Last touch date",
      "Last touch referrer",
      "Last touch landing page",
      "Last touch GCLID",
      "Last touch FBCLID",
      "Last touch MSCLKID",
      "Total touchpoints",
      "Touchpoints: Lead to Deal",
      "Touchpoints: Deal to Won",
      "First seen",
      "Last seen",
      "Pipedrive person ID",
      "Pipedrive URL",
    ],
    rows
  );
}

export function buildCampaignsCsv(touchpoints: Touchpoint[]): string {
  const counts = new Map<string, number>();
  for (const tp of touchpoints) {
    if (tp.campaign) counts.set(tp.campaign, (counts.get(tp.campaign) ?? 0) + 1);
  }
  const rows = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([campaign, count]) => [campaign, count]);

  return toCsv(["Campaign", "Touchpoints"], rows);
}

// yyyy-MM-dd HH:mm:ss +0000 — Google's documented format for the
// Conversion Time column, confirmed against multiple current (2026)
// sources at the time this was written. Every timestamp already stored
// in this app is effectively UTC, so the offset is always +0000 — no
// per-tenant timezone handling needed.
function formatGoogleAdsTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes()
  )}:${pad(d.getUTCSeconds())} +0000`;
}

/**
 * The dashboard's "Google Ads conversion feedback" export (see
 * routes/portal.ts and dashboard.html's matching card) — closes the
 * loop between Pipedrive outcomes and Google Ads' own bidding
 * algorithms. Upload the resulting file in Google Ads under Tools and
 * settings → Conversions → Uploads (5-column format: Google Click ID,
 * Conversion Name, Conversion Time, Conversion Value, Currency Code —
 * this is the standard, broadly-documented manual-upload format, not
 * the newer scheduled "Data Manager → upload from a URL" flow, which
 * has its own quirks; worth a quick check against the current Google
 * Ads UI before first use, since Google has been actively changing this
 * area of its product throughout 2026).
 *
 * Two conversion events per qualifying identity, not just one:
 *   - "CRM Deal Created" (zero value) — fires far more often than a
 *     Won deal, giving Google's Smart Bidding more volume to learn from
 *     sooner. Google's own guidance suggests ~30+ conversions/month
 *     before bidding algorithms stabilize; for a lower-volume tenant,
 *     Won-only would likely never reach that on its own.
 *   - "CRM Deal Won" — the clear, high-confidence "this was a good
 *     lead" signal.
 * Both require a Conversion Action created in the client's Google Ads
 * account with a name matching EXACTLY (character-for-character,
 * including capitalization) — that's a one-time setup step on their
 * side, same idea as the Pipedrive custom fields needing setup:pipedrive
 * run once per tenant.
 *
 * Conversion Value/Currency are always blank: this app doesn't capture
 * Pipedrive's Deal monetary value anywhere yet, so there's nothing
 * accurate to report. Leaving them blank is valid per Google's spec
 * (both columns are optional) — Target CPA bidding works fine without
 * them; Target ROAS specifically wants real values, so that's a natural
 * next step if this proves useful (capture Deal.value on the deal
 * webhook, same pattern as everything else in webhooks.ts).
 *
 * Only includes identities whose FIRST touch had a Google Click ID
 * (ad_click channel touchpoints capture this) — nothing to match a
 * conversion to an ad click without one, so those rows are silently
 * skipped rather than exported with a blank GCLID (which Google would
 * just reject anyway).
 */
export function buildGoogleAdsConversionsCsv(identities: Identity[], touchpoints: Touchpoint[]): string {
  const byIdentity = new Map<string, Touchpoint[]>();
  for (const tp of touchpoints) {
    if (!tp.identityId) continue;
    const list = byIdentity.get(tp.identityId) ?? [];
    list.push(tp);
    byIdentity.set(tp.identityId, list);
  }

  const rows: (string | number | null)[][] = [];
  for (const identity of identities) {
    const tps = byIdentity.get(identity.id) ?? [];
    const summary = buildAttributionSummary(tps);
    const gclid = summary?.firstTouchGclid;
    if (!gclid) continue;

    if (identity.dealCreatedDealId !== null && identity.dealCreatedAt) {
      rows.push([gclid, "CRM Deal Created", formatGoogleAdsTime(identity.dealCreatedAt), "", ""]);
    }
    if (identity.wonDealId !== null && identity.dealWonAt) {
      rows.push([gclid, "CRM Deal Won", formatGoogleAdsTime(identity.dealWonAt), "", ""]);
    }
  }

  return toCsv(["Google Click ID", "Conversion Name", "Conversion Time", "Conversion Value", "Currency Code"], rows);
}
