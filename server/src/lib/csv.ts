import { Identity, Touchpoint, isIdentified } from "../db";
import { buildAttributionSummary } from "./attribution";
import { deepLinkForPerson } from "./pipedrive";
import { createHash } from "crypto";

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
  includeAnonymous: boolean = true,
  segmentOptions: { id: string; name: string }[] = []
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
      identity.segmentValue
        ? identity.segmentValue
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
            .map((v) => segmentOptions.find((o) => o.id === v)?.name ?? v)
            .join(", ")
        : "",
      identity.dealValue !== null ? identity.dealValue : "",
      identity.dealCurrency ?? "",
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
      "Segment",
      "Deal value",
      "Deal currency",
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

// M/D/YYYY h:mm:ss AM/PM, no leading zeros on month/day/hour — matches
// the one fully authoritative example row found in Microsoft's own Bulk
// Service docs ("4/1/2020 6:50:54 PM"). See
// buildMicrosoftAdsConversionsCsv's doc comment for the caveat on
// exactly which upload flow this format was confirmed against.
function formatMicrosoftAdsTime(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  let hours = d.getUTCHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${hours}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} ${ampm}`;
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
 * Conversion Value/Currency: populated when known — "CRM Deal Won" uses
 * the identity's actual won value/currency (captured at the moment the
 * Deal was marked Won); "CRM Deal Created" uses the earlier
 * dealValueAtCreate estimate (see db.ts's Tenant.dealValueAtCreate doc
 * comment for why these are two separate captured numbers, not the same
 * value reused). Left blank when the underlying value wasn't captured
 * (e.g. a webhook that happened to omit it — see webhooks.ts's own
 * caveat on this) — blank is valid per Google's spec, Target CPA works
 * fine without a value; Target ROAS specifically wants one.
 *
 * Only includes identities whose FIRST touch had a Google Click ID
 * (ad_click channel touchpoints capture this) — nothing to match a
 * conversion to an ad click without one, so those rows are silently
 * skipped rather than exported with a blank GCLID (which Google would
 * just reject anyway).
 */
export function buildGoogleAdsConversionsCsv(identities: Identity[], touchpoints: Touchpoint[]): string {
  return buildAdClickConversionsCsv(identities, touchpoints, {
    clickIdHeader: "Google Click ID",
    currencyHeader: "Currency Code",
    getClickId: (s) => s.firstTouchGclid,
    formatTime: formatGoogleAdsTime,
  });
}

// Same shape as Google's export above (same doc comment applies for the
// overall design: two events, value/currency populated when known,
// only identities with a matching first-touch click ID) — this is the
// standard manual "Upload a file" CSV format under Tools > Conversion
// Tracking > Conversion Goals in Microsoft Advertising, confirmed
// against several current (2026) sources. One genuine format
// difference from Google: Conversion Time uses M/D/YYYY h:mm:ss AM/PM
// (no leading zeros), taken from Microsoft's own official Bulk Service
// documentation example row — the only fully authoritative source found
// for the exact string format, though that doc is technically for the
// Bulk API rather than the manual CSV upload specifically, so it's
// worth a quick check against the current upload UI before first use
// (same caveat as Google's own export). Also worth knowing: Microsoft's
// official downloadable template includes a timezone "Parameters" cell
// at the top of the file, which a from-scratch CSV like this one won't
// have — if the upload rejects on that, the timestamps below are in UTC
// (+0000), so setting the Parameters cell to 0000 should reconcile it.
export function buildMicrosoftAdsConversionsCsv(identities: Identity[], touchpoints: Touchpoint[]): string {
  return buildAdClickConversionsCsv(identities, touchpoints, {
    clickIdHeader: "Microsoft Click ID",
    currencyHeader: "Conversion Currency",
    getClickId: (s) => s.firstTouchMsclkid,
    formatTime: formatMicrosoftAdsTime,
  });
}

function buildAdClickConversionsCsv(
  identities: Identity[],
  touchpoints: Touchpoint[],
  opts: {
    clickIdHeader: string;
    currencyHeader: string;
    getClickId: (summary: NonNullable<ReturnType<typeof buildAttributionSummary>>) => string | null;
    formatTime: (d: Date) => string;
  }
): string {
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
    const clickId = summary ? opts.getClickId(summary) : null;
    if (!clickId) continue;

    if (identity.dealCreatedDealId !== null && identity.dealCreatedAt) {
      rows.push([
        clickId,
        "CRM Deal Created",
        opts.formatTime(identity.dealCreatedAt),
        identity.dealValueAtCreate ?? "",
        identity.dealValueAtCreate !== null ? identity.dealCurrencyAtCreate ?? "" : "",
      ]);
    }
    if (identity.wonDealId !== null && identity.dealWonAt) {
      rows.push([
        clickId,
        "CRM Deal Won",
        opts.formatTime(identity.dealWonAt),
        identity.dealValue ?? "",
        identity.dealValue !== null ? identity.dealCurrency ?? "" : "",
      ]);
    }
  }

  return toCsv([opts.clickIdHeader, "Conversion Name", "Conversion Time", "Conversion Value", opts.currencyHeader], rows);
}

/**
 * LinkedIn Ads conversion feedback — genuinely LESS certain than the
 * Google/Microsoft exports above, worth reading carefully before first
 * use. LinkedIn's manual "Upload a CSV file" flow in Campaign Manager
 * matches primarily by HASHED EMAIL (SHA-256), not by li_fat_id
 * directly — li_fat_id (LinkedIn's own click ID, captured via
 * routes/track.ts and stored per touchpoint since this same session)
 * is documented as a supplementary match signal used mainly through
 * LinkedIn's full Conversions API rather than the simple manual
 * upload. Every other export in this file (Google, Microsoft) was
 * built against a concrete, sourced example row; this one wasn't — the
 * exact column headers/order for LinkedIn's OWN downloadable template
 * weren't available to confirm, only the general shape (hashed email +
 * optional click ID + conversion name/time/value). Download LinkedIn's
 * actual template from Campaign Manager → Conversion Tracking before
 * first real upload and adjust column headers here if they differ.
 *
 * Email is lowercased and trimmed before hashing (LinkedIn's own
 * documented normalization for hashed-identifier matching, same
 * convention Google/Meta also use for their own hashed-match systems).
 * Only includes identities with both an email AND either a captured
 * li_fat_id OR a Deal milestone to report — an identity with neither
 * has nothing LinkedIn could plausibly match against.
 */
function sha256Lowercase(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export function buildLinkedInAdsConversionsCsv(identities: Identity[], touchpoints: Touchpoint[]): string {
  const byIdentity = new Map<string, Touchpoint[]>();
  for (const tp of touchpoints) {
    if (!tp.identityId) continue;
    const list = byIdentity.get(tp.identityId) ?? [];
    list.push(tp);
    byIdentity.set(tp.identityId, list);
  }

  const rows: (string | number | null)[][] = [];
  for (const identity of identities) {
    if (!identity.email) continue;
    const tps = byIdentity.get(identity.id) ?? [];
    const summary = buildAttributionSummary(tps);
    const liFatId = summary?.firstTouchLiFatId ?? "";
    const hashedEmail = sha256Lowercase(identity.email);

    if (identity.dealCreatedDealId !== null && identity.dealCreatedAt) {
      rows.push([
        hashedEmail,
        liFatId,
        "CRM Deal Created",
        formatGoogleAdsTime(identity.dealCreatedAt), // reused: same ISO-ish "yyyy-MM-dd HH:mm:ss" shape is broadly accepted, unlike Microsoft's specific AM/PM format which is Microsoft-documented, not LinkedIn-documented
        identity.dealValueAtCreate ?? "",
        identity.dealValueAtCreate !== null ? identity.dealCurrencyAtCreate ?? "" : "",
      ]);
    }
    if (identity.wonDealId !== null && identity.dealWonAt) {
      rows.push([
        hashedEmail,
        liFatId,
        "CRM Deal Won",
        formatGoogleAdsTime(identity.dealWonAt),
        identity.dealValue ?? "",
        identity.dealValue !== null ? identity.dealCurrency ?? "" : "",
      ]);
    }
  }

  return toCsv(["Hashed Email (SHA-256)", "LinkedIn Click ID", "Conversion Name", "Conversion Time", "Conversion Value", "Currency Code"], rows);
}
