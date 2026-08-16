import { Identity, Touchpoint } from "../db";
import { buildAttributionSummary } from "./attribution";

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

export interface RecentProspect {
  identityId: string;
  email: string | null;
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
}

export interface PortalSummary {
  totalIdentities: number;
  identifiedIdentities: number; // have a known email
  totalTouchpoints: number;
  firstTouchChannelCounts: ChannelCount[];
  lastTouchChannelCounts: ChannelCount[];
  topCampaigns: CampaignCount[];
  recent: RecentProspect[];
}

function toSortedChannelCounts(m: Map<string, number>): ChannelCount[] {
  return Array.from(m.entries())
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count);
}

export function buildPortalSummary(identities: Identity[], touchpoints: Touchpoint[]): PortalSummary {
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

  for (const identity of identities) {
    const tps = (byIdentity.get(identity.id) ?? [])
      .slice()
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const summary = buildAttributionSummary(tps);
    if (!summary) continue;

    firstCounts.set(summary.firstTouchChannel, (firstCounts.get(summary.firstTouchChannel) ?? 0) + 1);
    lastCounts.set(summary.lastTouchChannel, (lastCounts.get(summary.lastTouchChannel) ?? 0) + 1);
    for (const tp of tps) {
      if (tp.campaign) campaignCounts.set(tp.campaign, (campaignCounts.get(tp.campaign) ?? 0) + 1);
    }

    recent.push({
      identityId: identity.id,
      email: identity.email,
      firstTouchChannel: summary.firstTouchChannel,
      lastTouchChannel: summary.lastTouchChannel,
      touchpointCount: summary.touchpointCount,
      lastSeenAt: identity.lastSeenAt.toISOString(),
      firstTouchReferrer: summary.firstTouchReferrer,
      firstTouchSource: summary.firstTouchSource,
      firstTouchMedium: summary.firstTouchMedium,
      firstTouchCampaign: summary.firstTouchCampaign,
      firstTouchTerm: summary.firstTouchTerm,
      firstTouchContent: summary.firstTouchContent,
      leadToDealTouchpoints: identity.leadToDealTouchpoints,
      dealToWonTouchpoints: identity.dealToWonTouchpoints,
      pipedrivePersonId: identity.pipedrivePersonId,
    });
  }

  recent.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());

  return {
    totalIdentities: identities.length,
    identifiedIdentities: identities.filter((i) => i.email).length,
    totalTouchpoints: touchpoints.length,
    firstTouchChannelCounts: toSortedChannelCounts(firstCounts),
    lastTouchChannelCounts: toSortedChannelCounts(lastCounts),
    topCampaigns: Array.from(campaignCounts.entries())
      .map(([campaign, count]) => ({ campaign, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    recent: recent.slice(0, 25),
  };
}
