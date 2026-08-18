import { Identity, Touchpoint, isIdentified } from "../db";
import { buildAttributionSummary, CHANNEL_LABELS } from "./attribution";

/**
 * Aggregates across every identity for a tenant — the thing the Pipedrive
 * panel deliberately doesn't do (it's scoped to one Person/Deal record at
 * a time). This is what the /dashboard client login shows:
 * "which channels are actually producing prospects," not "what happened
 * on this one contact."
 *
 * Pure function (no I/O) so it's testable with fixture data — see
 * verify-portal.ts — the same pattern as buildAttributionSummary itself.
 */
export interface ChannelCount {
  channel: string;
  count: number;
}

export interface CampaignCount {
  campaign: string;
  count: number;
}

// "Conversion" here always means "this identity has a Deal" (i.e.
// dealCreatedDealId is set) — the same signal the Recently active
// prospects table already surfaces per-row via leadToDealTouchpoints/
// dealToWonTouchpoints, just aggregated here instead of shown per prospect.
// Grouped by each identity's own CURRENT first-touch value (via
// buildAttributionSummary, same living data the channel/campaign bars
// above already use) rather than any frozen Lead/Deal snapshot — this
// keeps every number on the dashboard describing "the journey as it
// looks today," consistent with how firstTouchChannelCounts/topCampaigns
// already work, rather than mixing living and frozen-at-a-past-moment
// data in the same view.
// Revenue is kept per-currency rather than summed into one blended
// number — adding £500 + $500 together would produce a meaningless
// total. Most tenants only ever see one currency here in practice, but
// this stays correct even if a tenant's deals aren't all in one.
export type RevenueByCurrency = Record<string, number>;

export interface SourceConversion {
  source: string;
  total: number;
  converted: number;
  rate: number; // 0–1, converted / total
  // Only from WON deals (not just "has a Deal") — see dealValue's doc
  // comment in db.ts. Empty object if nothing's been won from this
  // source yet, or none of the won deals had a captured value.
  wonRevenue: RevenueByCurrency;
  // Average days from first touch to Deal created, across converted
  // identities in this group — null if nobody's converted yet. A
  // genuinely different signal from the conversion rate itself: two
  // sources can convert at the same rate but close at very different
  // speeds.
  avgDaysToConvert: number | null;
  // Average total touchpoint count (whole journey, not just before Deal
  // creation) across identities in this group who've reached Won —
  // null if nobody's won yet. Answers "how much nurturing does it
  // typically take for this source to produce a Won deal," a different
  // question from avgDaysToConvert's "how long does it take."
  avgTouchpointsToWon: number | null;
}

export interface CampaignPerformance {
  campaign: string;
  total: number; // distinct identities whose first touch had this campaign — NOT the same count as topCampaigns above, which counts every touchpoint (so one prospect with 3 visits under the same campaign counts 3x there, 1x here). Kept as a separate field/panel rather than changing topCampaigns' existing meaning, since the CSV export and any saved links to it shouldn't silently change shape.
  converted: number;
  rate: number;
  wonRevenue: RevenueByCurrency;
  avgDaysToConvert: number | null;
  avgTouchpointsToWon: number | null;
}

// Same shape as SourceConversion/CampaignPerformance, but grouped by the
// tenant's configured segment field (see db.ts's Tenant.segmentFieldKey
// doc comment — Johari's own is Pipedrive Label). Empty array for any
// tenant that hasn't configured one, since no identity would have a
// segmentValue to group by. An identity with a MULTI-select segment
// value (e.g. two Labels) counts toward EACH of its segments' totals —
// the standard convention for multi-category reporting (a Deal tagged
// both "Villas" and "PPC" genuinely belongs in both groups), which does
// mean the totals across all segment rows can sum to more than the
// overall total tracked count. That's expected, not a bug.
export interface SegmentPerformance {
  segmentId: string;
  segmentName: string;
  total: number;
  converted: number;
  rate: number;
  wonRevenue: RevenueByCurrency;
  avgDaysToConvert: number | null;
  avgTouchpointsToWon: number | null;
}

// One entry per funnel stage, in order — deliberately an array rather
// than named fields, so dashboard.html can render it as a simple loop
// without knowing the stage list in advance (and so adding a stage later
// is a one-line change here, not a matching change in two places).
export interface FunnelStage {
  stage: string;
  count: number;
}

// One entry per week (Monday-start, UTC), covering the last
// CONVERSION_TREND_WEEKS weeks — a trend line, not a snapshot: shows
// whether a cohort's conversion rate is improving or declining over
// time, which the single-number rate in conversionBySource/
// campaignPerformance can't. IMPORTANT interpretation caveat, worth
// surfacing in the UI: `converted` reflects each identity's CURRENT
// state (has a Deal right now), not "had converted by the end of that
// week" — so a cohort from last week hasn't had as much time to convert
// as one from 10 weeks ago, and its rate will look artificially low for
// that reason alone, not necessarily because the leads were worse. The
// most recent 1–2 weeks should generally be read with that in mind.
export interface ConversionTrendWeek {
  weekStart: string; // YYYY-MM-DD, the Monday that week starts on (UTC)
  total: number;
  converted: number;
  rate: number;
}

export interface TouchpointsByDay {
  date: string; // YYYY-MM-DD, identity's local calendar day is NOT
  // used here — bucketed in UTC (same as every occurredAt timestamp
  // already stored) for consistency across tenants in different time
  // zones, not because it's necessarily the ideal display timezone.
  count: number;
}

// Segments every report on this dashboard by UTM dimension — matched
// against each identity's FIRST touch (same "first touch is the primary
// lens" convention already used throughout this file for
// conversionBySource/campaignPerformance), not against every individual
// touchpoint. An identity whose first visit was google/cpc but who later
// also clicked a Facebook ad still counts as "google" here — segmenting
// by "what originally brought this prospect in," not "every channel
// they've ever touched." All populated dimensions are ANDed together.
//
// `segment` is the odd one out — not a UTM dimension at all, but the
// tenant's configured Pipedrive segment field (see db.ts's
// Tenant.segmentFieldKey doc comment, e.g. Johari's Label). Folded into
// this same filter object rather than a parallel one, since that would
// mean threading a second filter through every place this one already
// flows (routes, the drill-down popup, both CSV exports, the dashboard's
// filter bar) for one extra field. Holds the RAW Pipedrive option ID,
// not the readable name — see matchesUtmFilter below for why.
export interface UtmFilter {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  segment?: string;
}

function utmFilterIsEmpty(filter?: UtmFilter): boolean {
  return !filter || !(filter.source || filter.medium || filter.campaign || filter.term || filter.content || filter.segment);
}

function matchesUtmFilter(
  identity: Identity,
  summary: NonNullable<ReturnType<typeof buildAttributionSummary>> | null,
  filter?: UtmFilter
): boolean {
  if (utmFilterIsEmpty(filter)) return true;
  const f = filter!;
  if (f.segment) {
    // Membership, not exact-match — identity.segmentValue is
    // comma-joined when the underlying Pipedrive field is multi-select
    // (a Deal/Lead can carry more than one Label), so "has label 12"
    // needs to check the list, not compare the whole string.
    const values = (identity.segmentValue || "").split(",").map((v) => v.trim()).filter(Boolean);
    if (!values.includes(f.segment)) return false;
  }
  if (f.source || f.medium || f.campaign || f.term || f.content) {
    if (!summary) return false;
    if (f.source && summary.firstTouchSource !== f.source) return false;
    if (f.medium && summary.firstTouchMedium !== f.medium) return false;
    if (f.campaign && summary.firstTouchCampaign !== f.campaign) return false;
    if (f.term && summary.firstTouchTerm !== f.term) return false;
    if (f.content && summary.firstTouchContent !== f.content) return false;
  }
  return true;
}

// The options a UTM filter dropdown should offer — always computed from
// the tenant's FULL, unfiltered touchpoint history (every touchpoint any
// identity ever had, not just first touches) regardless of whatever
// filter is currently applied, so the dropdown's own option list never
// shrinks or changes shape as the person filters — only the reports
// below it do.
export interface DistinctUtmValues {
  sources: string[];
  mediums: string[];
  campaigns: string[];
  terms: string[];
  contents: string[];
  // {id, name} pairs — only segment values actually present in this
  // tenant's data (not every option the Pipedrive field theoretically
  // offers), resolved to their readable name via segmentOptions.
  segments: { id: string; name: string }[];
}

function resolveSegmentName(id: string, segmentOptions?: { id: string; name: string }[]): string {
  return segmentOptions?.find((o) => o.id === id)?.name ?? id;
}

function collectDistinctUtmValues(
  touchpoints: Touchpoint[],
  identities: Identity[],
  segmentOptions?: { id: string; name: string }[]
): DistinctUtmValues {
  const sources = new Set<string>();
  const mediums = new Set<string>();
  const campaigns = new Set<string>();
  const terms = new Set<string>();
  const contents = new Set<string>();
  for (const tp of touchpoints) {
    if (tp.source) sources.add(tp.source);
    if (tp.medium) mediums.add(tp.medium);
    if (tp.campaign) campaigns.add(tp.campaign);
    if (tp.term) terms.add(tp.term);
    if (tp.content) contents.add(tp.content);
  }
  const segmentIds = new Set<string>();
  for (const identity of identities) {
    if (!identity.segmentValue) continue;
    for (const v of identity.segmentValue.split(",").map((s) => s.trim()).filter(Boolean)) segmentIds.add(v);
  }
  const alpha = (a: string, b: string) => a.localeCompare(b);
  return {
    sources: Array.from(sources).sort(alpha),
    mediums: Array.from(mediums).sort(alpha),
    campaigns: Array.from(campaigns).sort(alpha),
    terms: Array.from(terms).sort(alpha),
    contents: Array.from(contents).sort(alpha),
    segments: Array.from(segmentIds)
      .map((id) => ({ id, name: resolveSegmentName(id, segmentOptions) }))
      .sort((a, b) => alpha(a.name, b.name)),
  };
}

export interface RecentProspect {
  identityId: string;
  email: string | null;
  // Display-only fallback identifiers when email is unknown — see
  // db.ts's ensureColumn comment on identities.name/phone for why these
  // exist and why they're never used for matching/merging.
  name: string | null;
  phone: string | null;
  firstTouchChannel: string;
  lastTouchChannel: string;
  touchpointCount: number;
  lastSeenAt: string; // ISO
  // First-touch referrer, not last-touch — this column answers "where did
  // this prospect originally come from," the same story firstTouchChannel
  // already tells; the expanded per-visit timeline (see
  // routes/portal.ts's /prospects/:identityId) is where every visit's own
  // referrer shows up individually.
  firstTouchReferrer: string | null;
  // Enough of the first touchpoint's own detail (which source, which
  // campaign, which ad/post) for the list view to answer "which
  // particular ad/post caused this" without expanding the row — see
  // dashboard.html's firstTouchDetail(). Deliberately first-touch only,
  // same reasoning as firstTouchReferrer above.
  firstTouchSource: string;
  firstTouchMedium: string | null;
  firstTouchCampaign: string | null;
  firstTouchTerm: string | null;
  firstTouchContent: string | null;
  firstTouchGclid: string | null;
  firstTouchFbclid: string | null;
  // Deal value/currency — see db.ts's Identity interface doc comment on
  // dealValue for why this is captured at WON time specifically, not
  // an earlier estimate. Both null until (and unless) a Deal is won.
  dealValue: number | null;
  dealCurrency: string | null;
  // Deal-lifecycle milestones — how much engagement happened before this
  // contact became a Deal, and before that Deal was Won. Straight
  // pass-throughs of the Identity row (see db.ts's Identity interface and
  // webhooks.ts's deal handler, where these get frozen); unlike every
  // other field on this interface they're not derived from
  // buildAttributionSummary, since they need to freeze a count at a
  // specific past moment rather than describe the touchpoint list as it
  // stands today. Null until (respectively) a Deal has been created /
  // won for this contact.
  leadToDealTouchpoints: number | null;
  dealToWonTouchpoints: number | null;
  // Left as a bare ID here (rather than a full Pipedrive deep link) so this
  // stays a pure function with no knowledge of the tenant's company
  // domain — see routes/portal.ts's /summary handler, which attaches
  // pipedriveUrl using lib/pipedrive.ts's deepLinkForPerson once this
  // summary comes back.
  pipedrivePersonId: number | null;
  // Raw Pipedrive option ID(s) (comma-joined if multi-select) and the
  // resolved, readable name(s) — see Tenant.segmentFieldKey's doc
  // comment in db.ts. Null if the tenant hasn't configured a segment
  // field, or this identity's Lead/Deal never had it set.
  segmentValue: string | null;
  segmentLabel: string | null;
}

export interface PortalSummary {
  totalIdentities: number;
  identifiedIdentities: number; // have a known email
  totalTouchpoints: number;
  firstTouchChannelCounts: ChannelCount[];
  lastTouchChannelCounts: ChannelCount[];
  topCampaigns: CampaignCount[];
  recent: RecentProspect[];
  conversionBySource: SourceConversion[];
  campaignPerformance: CampaignPerformance[];
  segmentPerformance: SegmentPerformance[];
  funnel: FunnelStage[];
  // A parallel, £/$/€ view of just the two funnel stages where a real
  // monetary figure exists — "Total tracked"/"Identified"/"Lead
  // created" have no value concept in this data model, so they're
  // intentionally absent here rather than shown as a misleading "£0".
  // See db.ts's dealValueAtCreate doc comment for why "Deal created"
  // and "Won" use two DIFFERENT captured values, not the same number
  // twice.
  funnelValue: { stage: "Deal created" | "Won"; value: RevenueByCurrency }[];
  touchpointsByDay: TouchpointsByDay[];
  conversionTrend: ConversionTrendWeek[];
  // Multi-touch view: unlike everything else on this dashboard (all
  // first-touch, by deliberate convention), this answers "which
  // channels showed up ANYWHERE in a Won deal's journey" — surfacing
  // assist channels (retargeting, email nurture) that never get credit
  // as a first or last touch but may still have genuinely helped close
  // the deal. One entry per channel that appeared in at least one Won
  // journey; wonRate is "what fraction of ALL Won deals had this
  // channel present anywhere," so rows don't sum to 100% (a single Won
  // deal's journey can touch several channels, each counted).
  assistedConversions: { channel: string; wonCount: number; wonRate: number }[];
  distinctUtmValues: DistinctUtmValues;
}

function toSortedChannelCounts(m: Map<string, number>): ChannelCount[] {
  return Array.from(m.entries())
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count);
}

// Shared shape/sorting logic for conversionBySource and
// campaignPerformance below — both are "group identities by some
// first-touch attribute, count how many of each group have a Deal,"
// just keyed differently. Two small typed wrappers rather than one
// generic function, to keep the call sites plainly typed.
function averageOf(nums: number[] | undefined): number | null {
  if (!nums || !nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function revenueMapToObject(m: Map<string, number> | undefined): RevenueByCurrency {
  return m ? Object.fromEntries(m.entries()) : {};
}

function toSourceConversions(
  totals: Map<string, number>,
  converted: Map<string, number>,
  revenue: Map<string, Map<string, number>>,
  daysToConvert: Map<string, number[]>,
  touchpointsToWon: Map<string, number[]>
): SourceConversion[] {
  return Array.from(totals.entries())
    .map(([source, total]) => {
      const won = converted.get(source) ?? 0;
      return {
        source,
        total,
        converted: won,
        rate: total > 0 ? won / total : 0,
        wonRevenue: revenueMapToObject(revenue.get(source)),
        avgDaysToConvert: averageOf(daysToConvert.get(source)),
        avgTouchpointsToWon: averageOf(touchpointsToWon.get(source)),
      };
    })
    .sort((a, b) => b.total - a.total);
}

function toCampaignPerformance(
  totals: Map<string, number>,
  converted: Map<string, number>,
  revenue: Map<string, Map<string, number>>,
  daysToConvert: Map<string, number[]>,
  touchpointsToWon: Map<string, number[]>
): CampaignPerformance[] {
  return Array.from(totals.entries())
    .map(([campaign, total]) => {
      const won = converted.get(campaign) ?? 0;
      return {
        campaign,
        total,
        converted: won,
        rate: total > 0 ? won / total : 0,
        wonRevenue: revenueMapToObject(revenue.get(campaign)),
        avgDaysToConvert: averageOf(daysToConvert.get(campaign)),
        avgTouchpointsToWon: averageOf(touchpointsToWon.get(campaign)),
      };
    })
    .sort((a, b) => b.total - a.total);
}

function toSegmentPerformance(
  totals: Map<string, number>,
  converted: Map<string, number>,
  revenue: Map<string, Map<string, number>>,
  daysToConvert: Map<string, number[]>,
  touchpointsToWon: Map<string, number[]>,
  segmentOptions?: { id: string; name: string }[]
): SegmentPerformance[] {
  return Array.from(totals.entries())
    .map(([segmentId, total]) => {
      const won = converted.get(segmentId) ?? 0;
      return {
        segmentId,
        segmentName: resolveSegmentName(segmentId, segmentOptions),
        total,
        converted: won,
        rate: total > 0 ? won / total : 0,
        wonRevenue: revenueMapToObject(revenue.get(segmentId)),
        avgDaysToConvert: averageOf(daysToConvert.get(segmentId)),
        avgTouchpointsToWon: averageOf(touchpointsToWon.get(segmentId)),
      };
    })
    .sort((a, b) => b.total - a.total);
}

const TOUCHPOINTS_BY_DAY_WINDOW_DAYS = 30;
const CONVERSION_TREND_WEEKS = 12;

// UTC calendar-day bucketing — see TouchpointsByDay's doc comment for
// why UTC specifically. toISOString().slice(0, 10) is a cheap, exact way
// to get "YYYY-MM-DD in UTC" without a date library.
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The Monday (UTC) of the week containing d, at 00:00:00 — the week
// bucket key for ConversionTrendWeek. getUTCDay() is 0=Sunday..6=Saturday;
// the -6/+1 below maps that onto "days back to the most recent Monday."
function mondayOfWeek(d: Date): Date {
  const day = d.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

function toRecentProspect(
  identity: Identity,
  summary: ReturnType<typeof buildAttributionSummary>,
  segmentOptions?: { id: string; name: string }[]
): RecentProspect {
  return {
    identityId: identity.id,
    email: identity.email,
    name: identity.name,
    phone: identity.phone,
    firstTouchChannel: summary!.firstTouchChannel,
    lastTouchChannel: summary!.lastTouchChannel,
    touchpointCount: summary!.touchpointCount,
    lastSeenAt: identity.lastSeenAt.toISOString(),
    firstTouchReferrer: summary!.firstTouchReferrer,
    firstTouchSource: summary!.firstTouchSource,
    firstTouchMedium: summary!.firstTouchMedium,
    firstTouchCampaign: summary!.firstTouchCampaign,
    firstTouchTerm: summary!.firstTouchTerm,
    firstTouchContent: summary!.firstTouchContent,
    firstTouchGclid: summary!.firstTouchGclid,
    firstTouchFbclid: summary!.firstTouchFbclid,
    dealValue: identity.dealValue,
    dealCurrency: identity.dealCurrency,
    leadToDealTouchpoints: identity.leadToDealTouchpoints,
    dealToWonTouchpoints: identity.dealToWonTouchpoints,
    pipedrivePersonId: identity.pipedrivePersonId,
    segmentValue: identity.segmentValue,
    segmentLabel: identity.segmentValue
      ? identity.segmentValue
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => resolveSegmentName(v, segmentOptions))
          .join(", ")
      : null,
  };
}

export type ProspectFilter =
  | { type: "funnel"; value: "total" | "identified" | "lead" | "deal" | "won" }
  | { type: "source"; value: string }
  | { type: "campaign"; value: string }
  | { type: "segment"; value: string }
  | { type: "assistedChannel"; value: string };

// The actual matching logic, shared by filterProspects (JSON, for the
// dashboard's popup) and filterIdentities (raw Identity rows, for the
// popup's "Download CSV" button — see routes/portal.ts's
// /api/export/prospects-filtered.csv, which feeds these straight into
// the same buildProspectsCsv used by the main export). Keeping ONE
// filtering implementation means the popup's on-screen count and its
// downloaded CSV's row count can never silently disagree.
function matchingIdentities(
  identities: Identity[],
  touchpoints: Touchpoint[],
  filter: ProspectFilter,
  utmFilter?: UtmFilter
): Array<{ identity: Identity; summary: NonNullable<ReturnType<typeof buildAttributionSummary>> | null }> {
  const byIdentity = new Map<string, Touchpoint[]>();
  for (const tp of touchpoints) {
    if (!tp.identityId) continue;
    const list = byIdentity.get(tp.identityId) ?? [];
    list.push(tp);
    byIdentity.set(tp.identityId, list);
  }

  const results: Array<{ identity: Identity; summary: NonNullable<ReturnType<typeof buildAttributionSummary>> | null }> = [];
  for (const identity of identities) {
    if (filter.type === "funnel") {
      if (filter.value === "identified" && !identity.email) continue;
      if (filter.value === "lead" && !identity.leadCreatedAt) continue;
      if (filter.value === "deal" && identity.dealCreatedDealId === null) continue;
      if (filter.value === "won" && identity.wonDealId === null) continue;
    }

    const tps = (byIdentity.get(identity.id) ?? []).slice().sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const summary = buildAttributionSummary(tps);

    if (!matchesUtmFilter(identity, summary, utmFilter)) continue;

    // "total" is the one funnel value that matches even an identity with
    // zero touchpoints (no summary) — every other filter branch below
    // needs a real summary to check against, and an identity with no
    // touchpoints has no first-touch source/campaign/channel to match.
    // (An active utmFilter already excluded no-summary identities above,
    // via matchesUtmFilter's own `if (!summary) return false`.)
    if (filter.type === "funnel" && filter.value === "total") {
      results.push({ identity, summary });
      continue;
    }
    if (!summary) continue;

    if (filter.type === "source" && summary.firstTouchSource !== filter.value) continue;
    if (filter.type === "campaign" && summary.firstTouchCampaign !== filter.value) continue;
    if (filter.type === "segment") {
      const values = (identity.segmentValue || "").split(",").map((v) => v.trim()).filter(Boolean);
      if (!values.includes(filter.value)) continue;
    }
    if (filter.type === "assistedChannel") {
      // Mirrors assistedConversions' own matching exactly — WON only,
      // channel present ANYWHERE in the full journey (tps), not just
      // first/last touch. See PortalSummary.assistedConversions' doc
      // comment for the full reasoning.
      if (identity.wonDealId === null) continue;
      const hasChannel = tps.some((tp) => (CHANNEL_LABELS[tp.channel] || tp.channel) === filter.value);
      if (!hasChannel) continue;
    }

    results.push({ identity, summary });
  }

  results.sort((a, b) => b.identity.lastSeenAt.getTime() - a.identity.lastSeenAt.getTime());
  return results;
}

// Powers the dashboard's click-through drill-down — clicking a funnel
// stage, a conversion-by-source row, or a campaign-performance row calls
// this (via routes/portal.ts's /api/prospects/filtered) to show exactly
// which prospects make up that number. Deliberately NOT reusing
// buildPortalSummary's own `recent` array for this: that list is capped
// at the 25 most-recently-seen identities specifically for the default
// dashboard view, so filtering it client-side would silently return an
// incomplete (and misleadingly small) result for any tenant with more
// than 25 identified prospects. This recomputes from the full identity
// list instead, so a filtered result is always complete regardless of
// how many prospects the tenant has.
//
// The optional utmFilter composes with the ProspectFilter (AND, not
// OR) — if the dashboard's global UTM filter bar is active when someone
// clicks a funnel stage, the popup shows "of THIS UTM segment, who
// reached this funnel stage," not the whole tenant.
export function filterProspects(
  identities: Identity[],
  touchpoints: Touchpoint[],
  filter: ProspectFilter,
  utmFilter?: UtmFilter,
  segmentOptions?: { id: string; name: string }[]
): RecentProspect[] {
  return matchingIdentities(identities, touchpoints, filter, utmFilter)
    .filter((m) => m.summary) // "total" can include no-touchpoint identities with summary=null — nothing meaningful to show as a RecentProspect row for those (same exclusion buildPortalSummary's own `recent` list already applies)
    .map((m) => toRecentProspect(m.identity, m.summary, segmentOptions));
}

// Same filter, but returns the raw Identity rows instead of the
// dashboard's RecentProspect shape — for routes/portal.ts's CSV export,
// which needs actual Identity objects to hand to buildProspectsCsv (the
// same function the main "Download CSV" button already uses).
export function filterIdentities(
  identities: Identity[],
  touchpoints: Touchpoint[],
  filter: ProspectFilter,
  utmFilter?: UtmFilter
): Identity[] {
  return matchingIdentities(identities, touchpoints, filter, utmFilter).map((m) => m.identity);
}

// Powers the main "Recently active prospects" table's real pagination —
// unlike buildPortalSummary's own `recent` field (capped at 25, meant
// for a quick at-a-glance preview, kept as-is for backward compat since
// nothing on the dashboard reads it anymore once pagination shipped),
// this returns however many prospects actually match, sliced to the
// requested page, plus the true total so the UI can show "Page 2 of 9"
// correctly. Reuses filterProspects with the same neutral "total" funnel
// filter the unfiltered CSV export uses (see routes/portal.ts), so
// pagination and export can never disagree about who counts as a match.
export function paginateProspects(
  identities: Identity[],
  touchpoints: Touchpoint[],
  opts: { utmFilter?: UtmFilter; includeAnonymous: boolean; page: number; pageSize: number; segmentOptions?: { id: string; name: string }[] }
): { prospects: RecentProspect[]; total: number } {
  let all = filterProspects(identities, touchpoints, { type: "funnel", value: "total" }, opts.utmFilter, opts.segmentOptions);
  // Filtered server-side here (rather than left to the client, the way
  // the drill-down popup's already-complete, unbounded list does it) —
  // pagination boundaries need to be computed against the SAME set
  // that's actually being paged through, or "page 2" could either skip
  // real rows or repeat ones already shown on page 1 depending on how
  // many anonymous rows happened to fall on a given page.
  // Same "identified" definition as everywhere else (see db.ts's
  // isIdentified) — a name/phone-only lead isn't hidden by the
  // anonymous toggle just because email specifically is unknown.
  if (!opts.includeAnonymous) all = all.filter((p) => isIdentified(p));
  const total = all.length;
  const start = (opts.page - 1) * opts.pageSize;
  return { prospects: all.slice(start, start + opts.pageSize), total };
}

export function buildPortalSummary(
  identities: Identity[],
  touchpoints: Touchpoint[],
  utmFilter?: UtmFilter,
  segmentOptions?: { id: string; name: string }[]
): PortalSummary {
  // Always computed from the full, unfiltered touchpoint list — see
  // DistinctUtmValues' doc comment for why this must never itself be
  // affected by utmFilter.
  const distinctUtmValues = collectDistinctUtmValues(touchpoints, identities, segmentOptions);

  const byIdentity = new Map<string, Touchpoint[]>();
  for (const tp of touchpoints) {
    if (!tp.identityId) continue;
    const list = byIdentity.get(tp.identityId) ?? [];
    list.push(tp);
    byIdentity.set(tp.identityId, list);
  }

  const firstCounts = new Map<string, number>();
  const lastCounts = new Map<string, number>();
  const campaignCounts = new Map<string, number>();
  const recent: RecentProspect[] = [];

  const sourceTotals = new Map<string, number>();
  const sourceConverted = new Map<string, number>();
  const campaignTotals = new Map<string, number>();
  const campaignConverted = new Map<string, number>();
  const sourceRevenue = new Map<string, Map<string, number>>();
  const campaignRevenue = new Map<string, Map<string, number>>();
  const sourceDaysToConvert = new Map<string, number[]>();
  const campaignDaysToConvert = new Map<string, number[]>();
  const sourceTouchpointsToWon = new Map<string, number[]>();
  const campaignTouchpointsToWon = new Map<string, number[]>();
  const segmentTotals = new Map<string, number>();
  const segmentConverted = new Map<string, number>();
  const segmentRevenue = new Map<string, Map<string, number>>();
  const segmentDaysToConvert = new Map<string, number[]>();
  const segmentTouchpointsToWon = new Map<string, number[]>();
  const assistedConversionCounts = new Map<string, number>(); // channel label -> how many WON identities had it appear anywhere in their journey
  let totalWonForAssists = 0;
  let leadCreatedCount = 0;
  let dealCreatedCount = 0;
  let wonCount = 0;
  const dealCreatedValueByCurrency = new Map<string, number>();
  const wonValueByCurrency = new Map<string, number>();
  // Tracks the population actually included below — equals
  // identities.length only when utmFilter is empty (backward-compatible
  // with every existing "Total tracked"/totalIdentities behavior); once
  // a filter narrows things, these become "how many identities matched
  // the filter" instead, since a UTM segment is meaningless for an
  // identity with no touchpoints to check it against.
  let matchedCount = 0;
  let matchedIdentifiedCount = 0;
  const matchedIdentityIds = new Set<string>();

  // Zero-filled ahead of time (same reasoning as touchpointsByDay) so a
  // genuinely quiet week shows as 0%, not simply absent from the chart.
  const trendWeeks = new Map<string, { total: number; converted: number }>();
  const currentWeekStart = mondayOfWeek(new Date());
  for (let i = CONVERSION_TREND_WEEKS - 1; i >= 0; i--) {
    const ws = new Date(currentWeekStart.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    trendWeeks.set(dayKey(ws), { total: 0, converted: 0 });
  }
  const trendWindowStart = new Date(currentWeekStart.getTime() - (CONVERSION_TREND_WEEKS - 1) * 7 * 24 * 60 * 60 * 1000);

  for (const identity of identities) {
    const tps = (byIdentity.get(identity.id) ?? [])
      .slice()
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const summary = buildAttributionSummary(tps);
    if (!summary) continue;
    if (!matchesUtmFilter(identity, summary, utmFilter)) continue;

    matchedCount++;
    matchedIdentityIds.add(identity.id);
    if (identity.email) matchedIdentifiedCount++;

    const converted = identity.dealCreatedDealId !== null;
    if (identity.leadCreatedAt) leadCreatedCount++;
    if (identity.dealCreatedDealId !== null) dealCreatedCount++;
    if (identity.wonDealId !== null) wonCount++;
    if (identity.dealCreatedDealId !== null && identity.dealValueAtCreate !== null && identity.dealCurrencyAtCreate) {
      dealCreatedValueByCurrency.set(
        identity.dealCurrencyAtCreate,
        (dealCreatedValueByCurrency.get(identity.dealCurrencyAtCreate) ?? 0) + identity.dealValueAtCreate
      );
    }
    if (identity.wonDealId !== null && identity.dealValue !== null && identity.dealCurrency) {
      wonValueByCurrency.set(identity.dealCurrency, (wonValueByCurrency.get(identity.dealCurrency) ?? 0) + identity.dealValue);
    }

    firstCounts.set(summary.firstTouchChannel, (firstCounts.get(summary.firstTouchChannel) ?? 0) + 1);
    lastCounts.set(summary.lastTouchChannel, (lastCounts.get(summary.lastTouchChannel) ?? 0) + 1);
    for (const tp of tps) {
      if (tp.campaign) campaignCounts.set(tp.campaign, (campaignCounts.get(tp.campaign) ?? 0) + 1);
    }

    // One entry per identity here (not per touchpoint, unlike
    // campaignCounts/topCampaigns above) — a conversion rate needs "how
    // many distinct prospects" as its denominator, not "how many
    // touchpoints happened to mention this source/campaign."
    sourceTotals.set(summary.firstTouchSource, (sourceTotals.get(summary.firstTouchSource) ?? 0) + 1);
    if (converted) sourceConverted.set(summary.firstTouchSource, (sourceConverted.get(summary.firstTouchSource) ?? 0) + 1);
    if (summary.firstTouchCampaign) {
      campaignTotals.set(summary.firstTouchCampaign, (campaignTotals.get(summary.firstTouchCampaign) ?? 0) + 1);
      if (converted) {
        campaignConverted.set(summary.firstTouchCampaign, (campaignConverted.get(summary.firstTouchCampaign) ?? 0) + 1);
      }
    }

    // Revenue — only from WON deals with a captured value, kept
    // per-currency (see RevenueByCurrency's doc comment).
    if (identity.wonDealId !== null && identity.dealValue !== null && identity.dealCurrency) {
      const bySource = sourceRevenue.get(summary.firstTouchSource) ?? new Map<string, number>();
      bySource.set(identity.dealCurrency, (bySource.get(identity.dealCurrency) ?? 0) + identity.dealValue);
      sourceRevenue.set(summary.firstTouchSource, bySource);
      if (summary.firstTouchCampaign) {
        const byCampaign = campaignRevenue.get(summary.firstTouchCampaign) ?? new Map<string, number>();
        byCampaign.set(identity.dealCurrency, (byCampaign.get(identity.dealCurrency) ?? 0) + identity.dealValue);
        campaignRevenue.set(summary.firstTouchCampaign, byCampaign);
      }
    }

    // Time-to-convert — days from first touch to Deal created, one
    // sample per converted identity, averaged later in
    // toSourceConversions/toCampaignPerformance.
    if (converted && identity.dealCreatedAt) {
      const days = Math.max(
        0,
        (identity.dealCreatedAt.getTime() - new Date(summary.firstTouchDate).getTime()) / (24 * 60 * 60 * 1000)
      );
      const sourceDays = sourceDaysToConvert.get(summary.firstTouchSource) ?? [];
      sourceDays.push(days);
      sourceDaysToConvert.set(summary.firstTouchSource, sourceDays);
      if (summary.firstTouchCampaign) {
        const campaignDays = campaignDaysToConvert.get(summary.firstTouchCampaign) ?? [];
        campaignDays.push(days);
        campaignDaysToConvert.set(summary.firstTouchCampaign, campaignDays);
      }
    }

    // Touchpoints-to-won — the identity's full touchpoint count (whole
    // journey, not just up to Deal creation) as of now, one sample per
    // WON identity.
    if (identity.wonDealId !== null) {
      const sourceTps = sourceTouchpointsToWon.get(summary.firstTouchSource) ?? [];
      sourceTps.push(summary.touchpointCount);
      sourceTouchpointsToWon.set(summary.firstTouchSource, sourceTps);
      if (summary.firstTouchCampaign) {
        const campaignTps = campaignTouchpointsToWon.get(summary.firstTouchCampaign) ?? [];
        campaignTps.push(summary.touchpointCount);
        campaignTouchpointsToWon.set(summary.firstTouchCampaign, campaignTps);
      }
    }

    // Conversion by segment — every metric above, repeated for EACH of
    // this identity's segment IDs (comma-split, since a multi-select
    // Label means one identity can belong to more than one segment).
    if (identity.segmentValue) {
      const segmentIds = identity.segmentValue.split(",").map((v) => v.trim()).filter(Boolean);
      for (const segId of segmentIds) {
        segmentTotals.set(segId, (segmentTotals.get(segId) ?? 0) + 1);
        if (converted) segmentConverted.set(segId, (segmentConverted.get(segId) ?? 0) + 1);
        if (identity.wonDealId !== null && identity.dealValue !== null && identity.dealCurrency) {
          const bySegment = segmentRevenue.get(segId) ?? new Map<string, number>();
          bySegment.set(identity.dealCurrency, (bySegment.get(identity.dealCurrency) ?? 0) + identity.dealValue);
          segmentRevenue.set(segId, bySegment);
        }
        if (converted && identity.dealCreatedAt) {
          const days = Math.max(
            0,
            (identity.dealCreatedAt.getTime() - new Date(summary.firstTouchDate).getTime()) / (24 * 60 * 60 * 1000)
          );
          const segDays = segmentDaysToConvert.get(segId) ?? [];
          segDays.push(days);
          segmentDaysToConvert.set(segId, segDays);
        }
        if (identity.wonDealId !== null) {
          const segTps = segmentTouchpointsToWon.get(segId) ?? [];
          segTps.push(summary.touchpointCount);
          segmentTouchpointsToWon.set(segId, segTps);
        }
      }
    }

    // Multi-touch / assisted conversions — deliberately the ONE place
    // on this dashboard that looks at every touchpoint in a Won
    // identity's journey, not just first/last touch. See
    // PortalSummary.assistedConversions' own doc comment for the full
    // reasoning.
    if (identity.wonDealId !== null) {
      totalWonForAssists++;
      const channelsInJourney = new Set(tps.map((tp) => CHANNEL_LABELS[tp.channel] || tp.channel));
      for (const ch of channelsInJourney) {
        assistedConversionCounts.set(ch, (assistedConversionCounts.get(ch) ?? 0) + 1);
      }
    }

    // Conversion trend — which week bucket this identity's first touch
    // falls into, using CURRENT converted state (see
    // ConversionTrendWeek's doc comment on why that's an intentional,
    // documented interpretation choice, not an oversight).
    const firstTouchWeekKey = dayKey(mondayOfWeek(new Date(summary.firstTouchDate)));
    if (new Date(summary.firstTouchDate) >= trendWindowStart && trendWeeks.has(firstTouchWeekKey)) {
      const bucket = trendWeeks.get(firstTouchWeekKey)!;
      bucket.total++;
      if (converted) bucket.converted++;
    }

    recent.push(toRecentProspect(identity, summary, segmentOptions));
  }

  recent.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());

  // Daily touchpoint volume, last 30 days, zero-filled — a real chart
  // needs every day present (even at 0) so the x-axis reads as a
  // continuous timeline rather than skipping straight over quiet days.
  const dayCounts = new Map<string, number>();
  const now = new Date();
  for (let i = TOUCHPOINTS_BY_DAY_WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    dayCounts.set(dayKey(d), 0);
  }
  const windowStart = new Date(now.getTime() - TOUCHPOINTS_BY_DAY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const filterActive = !utmFilterIsEmpty(utmFilter);
  for (const tp of touchpoints) {
    if (tp.occurredAt < windowStart) continue;
    // Under an active UTM filter, only count a touchpoint if it belongs
    // to an identity whose first touch matched — same "segment the
    // whole dashboard to one cohort" idea as every other report here,
    // not "count individual touchpoints that happen to carry this UTM
    // value" (a converted prospect's later, unrelated visits shouldn't
    // silently drop out of their own cohort's daily volume just because
    // that particular visit had different UTM tags, or none at all).
    if (filterActive && (!tp.identityId || !matchedIdentityIds.has(tp.identityId))) continue;
    const key = dayKey(tp.occurredAt);
    if (dayCounts.has(key)) dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
  }
  const touchpointsByDay: TouchpointsByDay[] = Array.from(dayCounts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    totalIdentities: filterActive ? matchedCount : identities.length,
    identifiedIdentities: filterActive ? matchedIdentifiedCount : identities.filter((i) => i.email).length,
    totalTouchpoints: filterActive
      ? touchpoints.filter((tp) => tp.identityId && matchedIdentityIds.has(tp.identityId)).length
      : touchpoints.length,
    firstTouchChannelCounts: toSortedChannelCounts(firstCounts),
    lastTouchChannelCounts: toSortedChannelCounts(lastCounts),
    topCampaigns: Array.from(campaignCounts.entries())
      .map(([campaign, count]) => ({ campaign, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    recent: recent.slice(0, 25),
    conversionBySource: toSourceConversions(sourceTotals, sourceConverted, sourceRevenue, sourceDaysToConvert, sourceTouchpointsToWon).slice(0, 15),
    campaignPerformance: toCampaignPerformance(
      campaignTotals,
      campaignConverted,
      campaignRevenue,
      campaignDaysToConvert,
      campaignTouchpointsToWon
    ).slice(0, 15),
    segmentPerformance: toSegmentPerformance(
      segmentTotals,
      segmentConverted,
      segmentRevenue,
      segmentDaysToConvert,
      segmentTouchpointsToWon,
      segmentOptions
    ).slice(0, 15),
    funnel: [
      { stage: "Total tracked", count: filterActive ? matchedCount : identities.length },
      { stage: "Identified", count: filterActive ? matchedIdentifiedCount : identities.filter((i) => i.email).length },
      { stage: "Lead created", count: leadCreatedCount },
      { stage: "Deal created", count: dealCreatedCount },
      { stage: "Won", count: wonCount },
    ],
    funnelValue: [
      { stage: "Deal created", value: revenueMapToObject(dealCreatedValueByCurrency) },
      { stage: "Won", value: revenueMapToObject(wonValueByCurrency) },
    ],
    touchpointsByDay,
    conversionTrend: Array.from(trendWeeks.entries())
      .map(([weekStart, { total, converted }]) => ({
        weekStart,
        total,
        converted,
        rate: total > 0 ? converted / total : 0,
      }))
      .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1)),
    assistedConversions: Array.from(assistedConversionCounts.entries())
      .map(([channel, wonCount]) => ({ channel, wonCount, wonRate: totalWonForAssists > 0 ? wonCount / totalWonForAssists : 0 }))
      .sort((a, b) => b.wonCount - a.wonCount),
    distinctUtmValues,
  };
}
