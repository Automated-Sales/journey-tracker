import { Identity, Touchpoint } from "../db";
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
export function buildProspectsCsv(identities: Identity[], touchpoints: Touchpoint[], companyDomain: string | null = null): string {
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
    const tps = (byIdentity.get(identity.id) ?? []).slice().sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const summary = buildAttributionSummary(tps);
    if (!summary) continue;

    rows.push([
      identity.email || "(anonymous)",
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
