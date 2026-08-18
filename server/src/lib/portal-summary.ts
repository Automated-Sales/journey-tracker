import { Identity, Touchpoint, isIdentified } from "../db";
import { buildAttributionSummary, CHANNEL_LABELS, isMarketingChannel, normalizeSourceForDisplay } from "./attribution";

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
  // Not a UTM parameter — the touchpoint CHANNEL itself (e.g.
  // "ad_click", "website_visit", "pipedrive_lead_created"). Added
  // alongside the UTM-specific fields above because it's the one
  // dimension a person could reasonably want to filter by that wasn't
  // covered — narrows to identities whose FIRST touch was this
  // specific channel, same "first touch only" convention as every
  // other field here.
  channel?: string;
}

function utmFilterIsEmpty(filter?: UtmFilter): boolean {
  return (
    !filter || !(filter.source || filter.medium || filter.campaign || filter.term || filter.content || filter.segment || filter.channel)
  );
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
  if (f.source || f.medium || f.campaign || f.term || f.content || f.channel) {
    if (!summary) return false;
    if (f.source && summary.firstTouchSource !== f.source) return false;
    if (f.medium && summary.firstTouchMedium !== f.medium) return false;
    if (f.campaign && summary.firstTouchCampaign !== f.campaign) return false;
    if (f.term && summary.firstTouchTerm !== f.term) return false;
    if (f.content && summary.firstTouchContent !== f.content) return false;
    // firstTouchChannel is already the resolved label (e.g. "Ad click"),
    // not the raw channel key — see attribution.ts — matching the same
    // resolved-string convention distinctUtmValues below uses for the
    // dropdown's own option values.
    if (f.channel && summary.firstTouchChannel !== f.channel) return false;
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
  // Resolved labels (e.g. "Ad click"), not raw channel keys — same
  // "only values actually present in this tenant's data" scoping as
  // every other field here.
  channels: string[];
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
  const channels = new Set<string>();
  for (const tp of touchpoints) {
    if (tp.source) sources.add(tp.source);
    if (tp.medium) mediums.add(tp.medium);
    if (tp.campaign) campaigns.add(tp.campaign);
    if (tp.term) terms.add(tp.term);
    if (tp.content) contents.add(tp.content);
    channels.add(CHANNEL_LABELS[tp.channel] || tp.channel);
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
    channels: Array.from(channels).sort(alpha),
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
  firstTouchSource: string | null;
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
  // "Acquisition" fields — deliberately DIFFERENT from firstTouchChannel/
  // firstTouchSource above, which describe the chronologically first
  // touchpoint of ANY kind, CRM events included (so an identity whose
  // very first webhook was "Lead created" shows THAT as firstTouchChannel
  // — correct for the existing conversion-by-source/segment reports,
  // which all key off it consistently, but actively misleading for a
  // person reading the Recently active prospects table, who reasonably
  // expects "first touch" to mean "where did this person come from,"
  // not "what CRM event happened first"). These four instead describe
  // the first MARKETING touch specifically — see attribution.ts's
  // isMarketingChannel — and are null when NONE exists (an identity
  // with only CRM-event touchpoints, e.g. a lead worked entirely inside
  // Pipedrive with no tracked activity at all).
  acquisitionChannel: string | null;
  // Normalized for display (attribution.ts's normalizeSourceForDisplay
  // — e.g. a bare Instagram post URL becomes "Instagram"); acquisitionSourceRaw
  // keeps the original value for anyone who wants the literal URL/text.
  acquisitionSource: string | null;
  acquisitionSourceRaw: string | null;
  acquisitionCampaign: string | null;
  acquisitionLandingPage: string | null;
  // Single, collapsed "how far did this get commercially" status — the
  // same underlying milestones already on this interface
  // (leadToDealTouchpoints/dealToWonTouchpoints implying lead/deal
  // existence, dealValue implying Won), just combined into one glance-able
  // value rather than requiring several fields to be cross-referenced.
  status: "tracked" | "lead" | "deal" | "won";
  // See attribution.ts's isMarketingChannel doc comment and this
  // session's agreed classification: "attributed" (a real UTM campaign
  // or ad click ID), "partial" (a recognized marketing channel but no
  // structured campaign data — including anything from the lead-source
  // fallback, since that's inherently a best-effort guess rather than
  // real tracking), "direct" (a plain website visit with no referrer or
  // UTM at all — genuine direct traffic, not a tracking gap), "missing"
  // (no marketing touchpoint exists at all — our tracking never saw
  // this person).
  attributionStatus: AttributionStatus;
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
  // "Where do leads from each source get stuck?" — only identities with
  // a currently-OPEN Deal (has one, not yet Won) count here, bucketed
  // by their Deal's CURRENT stage (see db.ts's Identity.dealCurrentStageId
  // doc comment). Deliberately doesn't include a "Lost" bucket — this
  // app doesn't capture Lost status anywhere yet (webhooks.ts's deal
  // handler only has a "won" branch), a known gap rather than an
  // oversight here specifically.
  dealStageBySource: { source: string; stages: { stageName: string; count: number }[] }[];
  // Real multi-touch attribution — unlike everything else on this
  // dashboard (first-touch by deliberate convention) or
  // assistedConversions (binary "did this channel appear," multi-touch
  // but not weighted), this actually SPLITS each Won deal's value
  // across every channel in its journey, according to the chosen
  // model. All three models are precomputed here (not just the
  // currently-selected one) so switching between them on the dashboard
  // is instant, same pattern as funnel/funnelValue's Count/Value
  // toggle above. See computeMultiTouchAttribution's own doc comment
  // for exactly how each model weights touchpoints.
  multiTouchAttribution: {
    linear: MultiTouchAttributionRow[];
    timeDecay: MultiTouchAttributionRow[];
    uShaped: MultiTouchAttributionRow[];
  };
  notableChanges: NotableChange[];
  // Commercial top-of-page metrics — deliberately separate from the
  // existing funnel array (which already has dealCreatedCount/wonCount
  // equivalents buried in it) since these are meant to be the FIRST
  // thing shown, not something requiring a scan through funnel stages
  // to find. attributedLeadsCount specifically means "became a Lead AND
  // has real structured attribution" — the intersection of two
  // different existing concepts (identity.leadCreatedAt and
  // AttributionStatus 'attributed'), not just a rename of an existing
  // count.
  attributedLeadsCount: number;
  dealsCreatedCount: number;
  wonDealsCount: number;
  pipelineValue: RevenueByCurrency;
  wonRevenue: RevenueByCurrency;
  // "covered" = attributed + partial — "we know SOMETHING meaningful
  // about where this contact came from," not strictly "a fully
  // structured UTM campaign or click ID." Deliberately more generous
  // than the strict "attributed" bucket alone (see AttributionStatus's
  // own reasoning) — this is the headline number a client sees first,
  // and a business whose real lead flow comes mostly through something
  // like a WhatsApp fallback (always classified "partial," never
  // "attributed," since it's a best-effort guess rather than something
  // directly tracked) would otherwise see a needlessly harsh, misleading
  // "4% attributed" even though tracking is genuinely working. The
  // stricter attributed-only distinction is still fully preserved and
  // visible in attributionBreakdown below, for anyone drilling in who
  // already expects that nuance. "direct" and "missing" are both
  // deliberately excluded from "covered" — direct traffic has no
  // source to report at all (that's what direct means), and missing is
  // the genuine gap. total respects the active UTM filter, same
  // convention as totalIdentities elsewhere on this interface.
  attributionCoverage: { covered: number; total: number; rate: number };
  // "missing" + "partial" only — direct traffic isn't an issue, it's
  // genuinely just direct, so it's excluded from this count on purpose.
  attributionIssuesCount: number;
  // The full 4-bucket breakdown, plus a single weighted score out of
  // 100 — see attributionScore's own inline comment for exactly how
  // it's weighted. Distinct from attributionCoverage above (which only
  // exposes the "attributed" bucket, since that's a narrower, stricter
  // number worth its own top-level card) — this is the fuller picture,
  // for the dedicated Attribution Health section.
  attributionBreakdown: {
    attributed: number;
    partial: number;
    direct: number;
    missing: number;
    total: number;
    score: number;
  };
  distinctUtmValues: DistinctUtmValues;
}

// One row per channel, for whichever attribution model produced it.
// creditedConversions is intentionally a FRACTIONAL number, not an
// integer count — e.g. a channel that got 50% credit on each of 3 Won
// deals shows 1.5, not 3 — since that's the whole point of splitting
// credit rather than counting appearances.
export interface MultiTouchAttributionRow {
  channel: string;
  creditedRevenue: RevenueByCurrency;
  creditedConversions: number;
}

// Auto-surfaced insight text — "Facebook Ads volume dropped 40% this
// week" — rather than requiring someone to notice a dip by staring at
// a chart. See computeNotableChanges for the exact thresholds.
export interface NotableChange {
  text: string;
  direction: "increase" | "decrease";
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

/**
 * Weights for a Won identity's own sequence of touchpoints (already
 * sorted oldest-first), one weight per touchpoint, always summing to 1
 * (so multiplying by the deal's value distributes 100% of it, never
 * more or less, regardless of journey length).
 *
 * - linear: equal credit to every touchpoint.
 * - u_shaped (aka "position-based"): 40% to the first touch, 40% to the
 *   last touch, the remaining 20% split evenly among everything in
 *   between. Falls back to 50/50 for a 2-touchpoint journey (no
 *   "middle" exists) and 100% for a single-touchpoint journey.
 * - time_decay: exponential decay working backward from wonAt (or the
 *   last touchpoint if wonAt is somehow missing), 7-day half-life —
 *   a touchpoint 7 days before the deal closed gets half the credit of
 *   one on the closing day itself, 14 days before gets a quarter, etc.
 *   Normalized afterward so the weights still sum to 1.
 */
function computeTouchpointWeights(touchpoints: Touchpoint[], model: "linear" | "time_decay" | "u_shaped", wonAt: Date | null): number[] {
  const n = touchpoints.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  if (model === "linear") {
    return touchpoints.map(() => 1 / n);
  }

  if (model === "time_decay") {
    const HALF_LIFE_DAYS = 7;
    const reference = wonAt ?? touchpoints[n - 1].occurredAt;
    const rawWeights = touchpoints.map((tp) => {
      const daysBefore = Math.max(0, (reference.getTime() - tp.occurredAt.getTime()) / (24 * 60 * 60 * 1000));
      return Math.pow(2, -daysBefore / HALF_LIFE_DAYS);
    });
    const sum = rawWeights.reduce((a, b) => a + b, 0);
    return sum > 0 ? rawWeights.map((w) => w / sum) : touchpoints.map(() => 1 / n);
  }

  // u_shaped
  if (n === 2) return [0.5, 0.5];
  const middleCount = n - 2;
  const middleWeight = 0.2 / middleCount;
  return touchpoints.map((_, i) => (i === 0 || i === n - 1 ? 0.4 : middleWeight));
}

function computeMultiTouchAttribution(
  wonJourneys: { touchpoints: Touchpoint[]; dealValue: number | null; dealCurrency: string | null; dealWonAt: Date | null }[],
  model: "linear" | "time_decay" | "u_shaped"
): MultiTouchAttributionRow[] {
  const revenueByChannel = new Map<string, Map<string, number>>();
  const conversionsByChannel = new Map<string, number>();

  for (const journey of wonJourneys) {
    const sorted = [...journey.touchpoints].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const weights = computeTouchpointWeights(sorted, model, journey.dealWonAt);
    sorted.forEach((tp, i) => {
      const channel = CHANNEL_LABELS[tp.channel] || tp.channel;
      const weight = weights[i];
      conversionsByChannel.set(channel, (conversionsByChannel.get(channel) ?? 0) + weight);
      if (journey.dealValue !== null && journey.dealCurrency) {
        const byCurrency = revenueByChannel.get(channel) ?? new Map<string, number>();
        byCurrency.set(journey.dealCurrency, (byCurrency.get(journey.dealCurrency) ?? 0) + weight * journey.dealValue);
        revenueByChannel.set(channel, byCurrency);
      }
    });
  }

  return Array.from(conversionsByChannel.entries())
    .map(([channel, creditedConversions]) => ({
      channel,
      // Rounded to 2dp purely for display — the underlying math isn't
      // lossy, this just avoids showing "1.5000000000000002" from
      // ordinary floating-point accumulation.
      creditedConversions: Math.round(creditedConversions * 100) / 100,
      creditedRevenue: revenueMapToObject(revenueByChannel.get(channel)),
    }))
    .sort((a, b) => b.creditedConversions - a.creditedConversions);
}

const NOTABLE_CHANGE_THRESHOLD = 0.3; // 30%+ change to be worth surfacing
const NOTABLE_CHANGE_MIN_BASELINE = 3; // last week's count must be at least this — otherwise a jump from 1→3 touchpoints reads as a dramatic "200% increase" that's really just noise
const INSIGHT_MIN_BASELINE = 5; // don't flag a revenue-concentration or low-conversion insight based on a handful of prospects
const LOW_CONVERSION_RATE_THRESHOLD = 0.1; // below 10% deal conversion, worth flagging IF volume is meaningful
const STRONG_REVENUE_SHARE_THRESHOLD = 0.25; // a source generating a quarter or more of Won revenue is worth calling out by name

/**
 * The "What needs attention?" insights — four independent, entirely
 * deterministic rules (no AI/ML involved), merged into one sorted list:
 *
 *  1. Week-over-week touchpoint VOLUME by source (the original,
 *     unchanged — see its own reasoning below).
 *  2. Strongest REVENUE source — which source generated the largest
 *     share of Won revenue, only surfaced when that share is genuinely
 *     large (25%+), so this doesn't fire on a near-even split where
 *     naming a "winner" would be misleading.
 *  3. Volume without deals — a source producing a meaningful number of
 *     prospects but converting almost none of them to a Deal. Doesn't
 *     necessarily mean the channel is bad (see the avg-days-to-convert
 *     reporting elsewhere for the "give it time" counter-argument) —
 *     just genuinely worth a look.
 *  4. Attribution quality trend — compares the MISSING-attribution rate
 *     among newly-first-seen contacts this week vs last week, so a
 *     tracking regression (a broken snippet, a paused UTM habit) shows
 *     up as its own alert rather than silently degrading every other
 *     report's accuracy unnoticed.
 *
 * Rules 2-4 all require INSIGHT_MIN_BASELINE prospects before firing,
 * same "don't trust a tiny sample" principle as rule 1's own
 * NOTABLE_CHANGE_MIN_BASELINE.
 */
function computeNotableChanges(identities: Identity[], touchpoints: Touchpoint[]): NotableChange[] {
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const withMagnitude: { text: string; direction: "increase" | "decrease"; magnitude: number }[] = [];

  // --- Rule 1: week-over-week touchpoint volume by source ---
  const thisWeekBySource = new Map<string, number>();
  const lastWeekBySource = new Map<string, number>();
  for (const tp of touchpoints) {
    if (!tp.source) continue;
    if (tp.occurredAt >= oneWeekAgo && tp.occurredAt <= now) {
      thisWeekBySource.set(tp.source, (thisWeekBySource.get(tp.source) ?? 0) + 1);
    } else if (tp.occurredAt >= twoWeeksAgo && tp.occurredAt < oneWeekAgo) {
      lastWeekBySource.set(tp.source, (lastWeekBySource.get(tp.source) ?? 0) + 1);
    }
  }
  const allSources = new Set([...thisWeekBySource.keys(), ...lastWeekBySource.keys()]);
  for (const source of allSources) {
    const thisWeek = thisWeekBySource.get(source) ?? 0;
    const lastWeek = lastWeekBySource.get(source) ?? 0;
    if (lastWeek < NOTABLE_CHANGE_MIN_BASELINE) continue;
    const change = (thisWeek - lastWeek) / lastWeek;
    if (Math.abs(change) < NOTABLE_CHANGE_THRESHOLD) continue;
    const pct = Math.round(Math.abs(change) * 100);
    const direction: "increase" | "decrease" = change > 0 ? "increase" : "decrease";
    withMagnitude.push({
      text: `${source} touchpoint volume ${direction === "increase" ? "increased" : "dropped"} ${pct}% this week (${lastWeek} → ${thisWeek})`,
      direction,
      magnitude: Math.abs(change),
    });
  }

  // Shared setup for rules 2-4: per-identity touchpoints and a
  // per-source rollup of volume/conversion/won-revenue.
  const byIdentity = new Map<string, Touchpoint[]>();
  for (const tp of touchpoints) {
    if (!tp.identityId) continue;
    const list = byIdentity.get(tp.identityId) ?? [];
    list.push(tp);
    byIdentity.set(tp.identityId, list);
  }
  const bySource = new Map<string, { total: number; converted: number; wonRevenue: Map<string, number> }>();
  for (const identity of identities) {
    const tps = (byIdentity.get(identity.id) ?? []).slice().sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const summary = buildAttributionSummary(tps);
    if (!summary) continue;
    const bucket = bySource.get(summary.firstTouchSource) ?? { total: 0, converted: 0, wonRevenue: new Map<string, number>() };
    bucket.total++;
    if (identity.dealCreatedDealId !== null) bucket.converted++;
    if (identity.wonDealId !== null && identity.dealValue !== null && identity.dealCurrency) {
      bucket.wonRevenue.set(identity.dealCurrency, (bucket.wonRevenue.get(identity.dealCurrency) ?? 0) + identity.dealValue);
    }
    bySource.set(summary.firstTouchSource, bucket);
  }

  // --- Rule 2: strongest revenue source ---
  // Only considers ONE currency (whichever contributed the most Won
  // revenue overall) — mixing currencies into one "share" figure would
  // be meaningless, and a tenant with genuinely mixed-currency revenue
  // is a rare enough case that skipping this insight for them entirely
  // is preferable to a misleading blended number.
  const totalByCurrency = new Map<string, number>();
  for (const b of bySource.values()) {
    for (const [c, v] of b.wonRevenue) totalByCurrency.set(c, (totalByCurrency.get(c) ?? 0) + v);
  }
  let dominantCurrency: string | null = null;
  let dominantTotal = 0;
  for (const [c, v] of totalByCurrency) {
    if (v > dominantTotal) {
      dominantCurrency = c;
      dominantTotal = v;
    }
  }
  if (dominantCurrency && dominantTotal > 0) {
    let topSource: string | null = null;
    let topRevenue = 0;
    let topSourceTotal = 0;
    for (const [source, b] of bySource) {
      const rev = b.wonRevenue.get(dominantCurrency) ?? 0;
      if (rev > topRevenue) {
        topSource = source;
        topRevenue = rev;
        topSourceTotal = b.total;
      }
    }
    if (topSource) {
      const revenueShare = topRevenue / dominantTotal;
      if (revenueShare >= STRONG_REVENUE_SHARE_THRESHOLD) {
        const totalProspects = Array.from(bySource.values()).reduce((sum, b) => sum + b.total, 0);
        const prospectShare = totalProspects > 0 ? Math.round((topSourceTotal / totalProspects) * 100) : 0;
        withMagnitude.push({
          text: `${topSource} is your strongest revenue source — generated ${Math.round(revenueShare * 100)}% of Won revenue from ${prospectShare}% of tracked prospects.`,
          direction: "increase",
          magnitude: revenueShare,
        });
      }
    }
  }

  // --- Rule 3: volume without deals ---
  for (const [source, b] of bySource) {
    if (b.total < INSIGHT_MIN_BASELINE) continue;
    const rate = b.converted / b.total;
    if (rate < LOW_CONVERSION_RATE_THRESHOLD) {
      withMagnitude.push({
        text: `${source} is generating prospects but few deals — ${b.total} prospects → ${b.converted} deal${b.converted === 1 ? "" : "s"} so far.`,
        direction: "decrease",
        magnitude: 1 - rate,
      });
    }
  }

  // --- Rule 4: attribution quality trend ---
  // "First seen" here means this identity's OWN first touchpoint,
  // regardless of channel (deliberately not restricted to marketing
  // touches like acquisitionChannel elsewhere) — the question this rule
  // answers is "when did tracking first pick this person up," and a
  // CRM-only identity (no marketing touch ever recorded) picked up this
  // week is exactly the kind of gap this rule exists to catch.
  let thisWeekTotal = 0;
  let thisWeekMissing = 0;
  let lastWeekTotal = 0;
  let lastWeekMissing = 0;
  for (const identity of identities) {
    const tps = (byIdentity.get(identity.id) ?? []).slice().sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    if (!tps.length) continue;
    const firstSeen = tps[0].occurredAt;
    const { status } = classifyAttribution(tps);
    if (firstSeen >= oneWeekAgo && firstSeen <= now) {
      thisWeekTotal++;
      if (status === "missing") thisWeekMissing++;
    } else if (firstSeen >= twoWeeksAgo && firstSeen < oneWeekAgo) {
      lastWeekTotal++;
      if (status === "missing") lastWeekMissing++;
    }
  }
  if (thisWeekTotal >= INSIGHT_MIN_BASELINE && lastWeekTotal >= INSIGHT_MIN_BASELINE) {
    const thisWeekRate = thisWeekMissing / thisWeekTotal;
    const lastWeekRate = lastWeekMissing / lastWeekTotal;
    if (thisWeekRate - lastWeekRate >= 0.15) {
      withMagnitude.push({
        text: `Attribution quality has dropped — ${Math.round(thisWeekRate * 100)}% of new contacts this week arrived without source information, up from ${Math.round(lastWeekRate * 100)}% last week.`,
        direction: "decrease",
        magnitude: thisWeekRate - lastWeekRate,
      });
    }
  }

  return withMagnitude.sort((a, b) => b.magnitude - a.magnitude).map(({ text, direction }) => ({ text, direction }));
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

export type AttributionStatus = "attributed" | "partial" | "direct" | "missing";

// Extracted so both toRecentProspect (per-row, for the table) AND
// buildPortalSummary's top-level attribution coverage stat (across
// EVERY identity, not just the 25 shown in the table) use the exact
// same classification, rather than two copies drifting apart over
// time. See RecentProspect.attributionStatus's own doc comment for the
// full reasoning behind each bucket.
function classifyAttribution(touchpoints: Touchpoint[]): { firstMarketingTouch: Touchpoint | null; status: AttributionStatus } {
  const marketingTouches = touchpoints
    .filter((tp) => isMarketingChannel(tp.channel))
    .slice()
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const firstMarketingTouch = marketingTouches[0] ?? null;

  let status: AttributionStatus;
  if (!firstMarketingTouch) {
    status = "missing";
  } else if (firstMarketingTouch.channel === "lead_source_field") {
    // A best-effort fallback guess, not real tracking — never
    // "attributed" even if it happens to carry campaign-shaped text.
    status = "partial";
  } else if (firstMarketingTouch.campaign || firstMarketingTouch.gclid || firstMarketingTouch.fbclid || firstMarketingTouch.msclkid) {
    status = "attributed";
  } else if (firstMarketingTouch.channel === "website_visit" && !firstMarketingTouch.referrer) {
    status = "direct"; // genuine direct traffic (typed URL, bookmark) — not a tracking gap
  } else {
    status = "partial"; // a recognized channel (organic social, website with a referrer, email) but no structured campaign/click-id data
  }
  return { firstMarketingTouch, status };
}

function toRecentProspect(
  identity: Identity,
  summary: ReturnType<typeof buildAttributionSummary>,
  touchpoints: Touchpoint[],
  segmentOptions?: { id: string; name: string }[]
): RecentProspect {
  const { firstMarketingTouch, status: attributionStatus } = classifyAttribution(touchpoints);

  // A genuinely zero-touchpoint identity — exactly what "missing"
  // attribution status means — has no summary to draw from at all.
  // Every summary-derived field below falls back to a clear, honest
  // "nothing tracked" value rather than crashing (this function used to
  // assume a summary always existed via non-null assertions, which is
  // why filterProspects had its own blanket "drop anything with a null
  // summary" step — that step incorrectly ALSO dropped these
  // legitimately-missing identities from the attributionIssue
  // drill-down, which specifically needs to show them).
  const NO_TOUCH = "No tracked touch";

  return {
    identityId: identity.id,
    email: identity.email,
    name: identity.name,
    phone: identity.phone,
    firstTouchChannel: summary?.firstTouchChannel ?? NO_TOUCH,
    lastTouchChannel: summary?.lastTouchChannel ?? NO_TOUCH,
    touchpointCount: summary?.touchpointCount ?? 0,
    lastSeenAt: identity.lastSeenAt.toISOString(),
    firstTouchReferrer: summary?.firstTouchReferrer ?? null,
    firstTouchSource: summary?.firstTouchSource ?? null,
    firstTouchMedium: summary?.firstTouchMedium ?? null,
    firstTouchCampaign: summary?.firstTouchCampaign ?? null,
    firstTouchTerm: summary?.firstTouchTerm ?? null,
    firstTouchContent: summary?.firstTouchContent ?? null,
    firstTouchGclid: summary?.firstTouchGclid ?? null,
    firstTouchFbclid: summary?.firstTouchFbclid ?? null,
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
    acquisitionChannel: firstMarketingTouch ? CHANNEL_LABELS[firstMarketingTouch.channel] || firstMarketingTouch.channel : null,
    acquisitionSource: firstMarketingTouch ? normalizeSourceForDisplay(firstMarketingTouch.source) : null,
    acquisitionSourceRaw: firstMarketingTouch?.source ?? null,
    acquisitionCampaign: firstMarketingTouch?.campaign ?? null,
    acquisitionLandingPage: firstMarketingTouch?.url ?? null,
    status: identity.wonDealId !== null ? "won" : identity.dealCreatedDealId !== null ? "deal" : identity.leadCreatedAt ? "lead" : "tracked",
    attributionStatus,
  };
}

export type ProspectFilter =
  | { type: "funnel"; value: "total" | "identified" | "lead" | "deal" | "won" }
  | { type: "source"; value: string }
  | { type: "campaign"; value: string }
  | { type: "segment"; value: string }
  | { type: "assistedChannel"; value: string }
  // For the "Attribution Coverage"/"N tracking issues" top-level card —
  // matches "missing" or "partial" specifically (see
  // attributionIssuesCount's own doc comment for why "direct" is
  // deliberately excluded from counting as an issue).
  | { type: "attributionIssue"; value: "true" }
  // For the Attribution Health section's individual bucket drill-downs
  // (e.g. clicking "12 Direct" specifically) — a strict SINGLE-status
  // match, unlike attributionIssue above which combines two.
  | { type: "attributionStatus"; value: AttributionStatus };

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
): Array<{ identity: Identity; summary: NonNullable<ReturnType<typeof buildAttributionSummary>> | null; tps: Touchpoint[] }> {
  const byIdentity = new Map<string, Touchpoint[]>();
  for (const tp of touchpoints) {
    if (!tp.identityId) continue;
    const list = byIdentity.get(tp.identityId) ?? [];
    list.push(tp);
    byIdentity.set(tp.identityId, list);
  }

  const results: Array<{ identity: Identity; summary: NonNullable<ReturnType<typeof buildAttributionSummary>> | null; tps: Touchpoint[] }> = [];
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
      results.push({ identity, summary, tps });
      continue;
    }
    // Same reasoning as "total" above — a zero-touchpoint identity is
    // EXACTLY what "missing" attribution means (classifyAttribution
    // handles an empty array gracefully, returning "missing"), so this
    // needs to run before the summary-required guard below, not be
    // excluded by it.
    if (filter.type === "attributionIssue") {
      const { status } = classifyAttribution(tps);
      if (status === "missing" || status === "partial") results.push({ identity, summary, tps });
      continue;
    }
    if (filter.type === "attributionStatus") {
      const { status } = classifyAttribution(tps);
      if (status === filter.value) results.push({ identity, summary, tps });
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

    results.push({ identity, summary, tps });
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
  // No longer filters out null-summary results here — toRecentProspect
  // is now null-safe (falls back to "No tracked touch" etc rather than
  // crashing), so whichever identities matchingIdentities decided to
  // include (a zero-touchpoint one for "total", or for
  // attributionIssue specifically) correctly show up as a real row,
  // not get silently dropped by a blanket filter that predates
  // toRecentProspect being able to handle this case at all.
  return matchingIdentities(identities, touchpoints, filter, utmFilter).map((m) => toRecentProspect(m.identity, m.summary, m.tps, segmentOptions));
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
  const stageBySourceCounts = new Map<string, Map<string, number>>(); // firstTouchSource -> stageName -> count of OPEN deals currently in that stage
  const wonJourneys: { touchpoints: Touchpoint[]; dealValue: number | null; dealCurrency: string | null; dealWonAt: Date | null }[] = [];
  let leadCreatedCount = 0;
  let dealCreatedCount = 0;
  let wonCount = 0;
  const dealCreatedValueByCurrency = new Map<string, number>();
  const wonValueByCurrency = new Map<string, number>();
  // OPEN deals only (has one, not yet Won) — a genuinely different
  // population from dealCreatedValueByCurrency above, which includes
  // deals that have SINCE won. "Pipeline value" specifically means
  // "still in progress," so a won deal's value belongs in wonRevenue,
  // not here, even though it also went through dealValueAtCreate once.
  const pipelineValueByCurrency = new Map<string, number>();
  // Attribution coverage/issues — computed across every identity that
  // matches the active filter (same convention as totalIdentities
  // above), NOT gated on the main loop's own `if (!summary) continue`,
  // since a zero-touchpoint identity should correctly count as
  // "missing" here rather than being silently excluded from the
  // denominator. "attributed" is deliberately the ONLY bucket counted
  // as covered — "direct" and "partial" are each legitimate, distinct
  // buckets in their own right (see AttributionStatus's own reasoning),
  // not partial credit toward this specific number. attributionIssues
  // is "missing" + "partial" only — direct traffic isn't an issue, it's
  // genuinely just direct.
  let attributionAttributedCount = 0;
  let attributionPartialCount = 0;
  let attributionDirectCount = 0;
  let attributionMissingCount = 0;
  let attributionTotalCount = 0;
  let attributedLeadsCount = 0;
  for (const identity of identities) {
    const tps = (byIdentity.get(identity.id) ?? []).slice().sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const summary = buildAttributionSummary(tps);
    if (!matchesUtmFilter(identity, summary, utmFilter)) continue;
    attributionTotalCount++;
    const { status } = classifyAttribution(tps);
    if (status === "attributed") attributionAttributedCount++;
    if (status === "partial") attributionPartialCount++;
    if (status === "direct") attributionDirectCount++;
    if (status === "missing") attributionMissingCount++;
    if (identity.leadCreatedAt && status === "attributed") attributedLeadsCount++;
  }
  const attributionIssuesCount = attributionMissingCount + attributionPartialCount;
  // Weighted score out of 100 — "attributed" is full credit (real
  // structured tracking), "direct" is high-but-not-full credit
  // (tracking is genuinely working, there's just no channel to
  // attribute since none exists — not a gap, but also not the gold
  // standard of a known campaign), "partial" is half credit (SOME
  // signal, not structured), "missing" is zero (a genuine tracking
  // gap). Weights are a judgment call, not a standard formula — chosen
  // to reward real attribution clearly while still giving credit for
  // honestly-direct traffic rather than penalizing it the same as an
  // actual gap.
  const attributionScore =
    attributionTotalCount > 0
      ? Math.round(
          ((attributionAttributedCount * 1 + attributionDirectCount * 0.9 + attributionPartialCount * 0.5 + attributionMissingCount * 0) /
            attributionTotalCount) *
            100
        )
      : 0;
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
      if (identity.wonDealId === null) {
        pipelineValueByCurrency.set(
          identity.dealCurrencyAtCreate,
          (pipelineValueByCurrency.get(identity.dealCurrencyAtCreate) ?? 0) + identity.dealValueAtCreate
        );
      }
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

    // Deal stage by source — "where do leads from each source get
    // stuck?" Only OPEN deals count (has one, not yet Won) — a Won
    // identity has exited the pipeline, so bucketing it under its
    // pre-win stage would misrepresent where things currently stand.
    if (identity.dealCreatedDealId !== null && identity.wonDealId === null && identity.dealCurrentStageName) {
      const bySource = stageBySourceCounts.get(summary.firstTouchSource) ?? new Map<string, number>();
      bySource.set(identity.dealCurrentStageName, (bySource.get(identity.dealCurrentStageName) ?? 0) + 1);
      stageBySourceCounts.set(summary.firstTouchSource, bySource);
    }

    // Multi-touch attribution — same population as assistedConversions
    // (every Won identity's full touchpoint list), but this one splits
    // credit rather than just noting presence. Collected here, weighted
    // and aggregated once at the end for all three models — see
    // computeMultiTouchAttribution's own doc comment.
    if (identity.wonDealId !== null) {
      wonJourneys.push({ touchpoints: tps, dealValue: identity.dealValue, dealCurrency: identity.dealCurrency, dealWonAt: identity.dealWonAt });
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

    recent.push(toRecentProspect(identity, summary, tps, segmentOptions));
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
    dealStageBySource: Array.from(stageBySourceCounts.entries())
      .map(([source, stages]) => ({
        source,
        stages: Array.from(stages.entries())
          .map(([stageName, count]) => ({ stageName, count }))
          .sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => {
        const totalA = a.stages.reduce((sum, s) => sum + s.count, 0);
        const totalB = b.stages.reduce((sum, s) => sum + s.count, 0);
        return totalB - totalA;
      }),
    multiTouchAttribution: {
      linear: computeMultiTouchAttribution(wonJourneys, "linear"),
      timeDecay: computeMultiTouchAttribution(wonJourneys, "time_decay"),
      uShaped: computeMultiTouchAttribution(wonJourneys, "u_shaped"),
    },
    // Full, unfiltered touchpoints — same "always the whole picture,
    // regardless of the current UTM filter" convention as
    // distinctUtmValues. A week-over-week volume comparison narrowed to
    // whatever filter happens to be active would mostly just reflect
    // the filter itself, not a real change worth surfacing.
    notableChanges: computeNotableChanges(identities, touchpoints),
    attributedLeadsCount,
    dealsCreatedCount: dealCreatedCount,
    wonDealsCount: wonCount,
    pipelineValue: revenueMapToObject(pipelineValueByCurrency),
    wonRevenue: revenueMapToObject(wonValueByCurrency),
    attributionCoverage: {
      covered: attributionAttributedCount + attributionPartialCount,
      total: attributionTotalCount,
      rate: attributionTotalCount > 0 ? (attributionAttributedCount + attributionPartialCount) / attributionTotalCount : 0,
    },
    attributionIssuesCount,
    attributionBreakdown: {
      attributed: attributionAttributedCount,
      partial: attributionPartialCount,
      direct: attributionDirectCount,
      missing: attributionMissingCount,
      total: attributionTotalCount,
      score: attributionScore,
    },
    distinctUtmValues,
  };
}
