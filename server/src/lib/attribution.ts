import { Touchpoint } from "../db";

// Same badge labels the panel uses, kept in one place so the custom-field
// summary text and the panel timeline describe channels the same way.
export const CHANNEL_LABELS: Record<string, string> = {
  ad_click: "Ad click",
  ad_impression: "Ad seen",
  website_visit: "Website",
  email_open: "Email opened",
  email_click: "Email click",
  email_reply: "Email reply",
  pipedrive_activity: "Sales activity",
  pipedrive_stage_change: "Deal stage",
  pipedrive_note: "Note",
  // Untagged (no utm_source, no ad click ID) traffic whose referrer
  // matches a known social platform — see routes/track.ts's
  // inferFromReferrer. Kept as its own channel (rather than folded into
  // website_visit) so the dashboard's channel-breakdown chart actually
  // surfaces organic social as a distinct bucket instead of lumping it
  // in with generic direct/website traffic.
  social_organic: "Organic social",
  // See types.ts's Channel doc comment for this one — a per-tenant
  // configured Pipedrive field, used only as a last-resort fallback for
  // a lead our own tracking never saw at all. Labeled "Lead source", not
  // "Lead form" — the original use case (Johari's Social Form Source
  // field) genuinely was a form submission, but this same mechanism now
  // covers any configured field, which might just be a plain dropdown
  // (e.g. "Referral", "Existing Customer") with no form involved at all.
  lead_source_field: "Lead source",
  // See types.ts's Channel doc comment — an unconditional "this became
  // a Lead" marker, separate from lead_source_field above.
  pipedrive_lead_created: "Lead created",
  pipedrive_deal_created: "Deal created",
};

// Splits every channel into two categories, for the "Recently active
// prospects" table's acquisition columns (see portal-summary.ts's
// buildAcquisitionSummary): channels that answer "where did this person
// come from" (a genuine marketing touch) vs. channels that just record
// something happening inside Pipedrive (a CRM event). Mixing these up
// was the actual root problem in the old "First touch: Lead created,
// Source: pipedrive" display — "Lead created" is an EVENT, not an
// acquisition channel, and showing it as if it were one is actively
// misleading, not just imprecise. pipedrive_stage_change/
// pipedrive_activity/pipedrive_note/pipedrive_lead_created/
// pipedrive_deal_created are all deliberately CRM-only — everything
// else counts as marketing.
const CRM_EVENT_CHANNELS = new Set([
  "pipedrive_activity",
  "pipedrive_note",
  "pipedrive_stage_change",
  "pipedrive_lead_created",
  "pipedrive_deal_created",
]);

export function isMarketingChannel(channel: string): boolean {
  return !CRM_EVENT_CHANNELS.has(channel);
}

// Recognized platform domains, for turning a raw fallback-captured URL
// (e.g. "https://www.instagram.com/p/DcJOBtlgfqT") into a clean display
// name ("Instagram") — the RAW value stays available in full elsewhere
// (the identity's touchpoint timeline, CSV exports) for anyone who
// wants it; this is purely a table-display cleanup, not a new field of
// its own. Deliberately just a hostname match, not an attempt to guess
// paid vs. organic — a bare post URL genuinely can't tell you that (a
// paid ad often promotes an existing organic post using that same
// link) — see db.ts's Tenant.paidIndicatorField doc comment for the
// full reasoning on why that specific inference isn't made here.
const KNOWN_SOURCE_DOMAINS: { match: RegExp; name: string }[] = [
  { match: /(^|\.)instagram\.com$/, name: "Instagram" },
  { match: /(^|\.)facebook\.com$/, name: "Facebook" },
  { match: /^fb\.me$/, name: "Facebook" },
  { match: /(^|\.)tiktok\.com$/, name: "TikTok" },
  { match: /(^|\.)youtube\.com$/, name: "YouTube" },
  { match: /^youtu\.be$/, name: "YouTube" },
  { match: /(^|\.)linkedin\.com$/, name: "LinkedIn" },
  { match: /(^|\.)(twitter\.com|x\.com)$/, name: "Twitter/X" },
  { match: /(^|\.)wa\.me$/, name: "WhatsApp" },
  { match: /(^|\.)whatsapp\.com$/, name: "WhatsApp" },
  { match: /(^|\.)google\.com$/, name: "Google" },
];

export function normalizeSourceForDisplay(rawSource: string | null): string | null {
  if (!rawSource) return rawSource;
  let url: URL;
  try {
    url = new URL(rawSource);
  } catch {
    return rawSource; // not a URL at all — already a clean value (e.g. "WhatsApp", "Referral"), shown as-is
  }
  const host = url.hostname.replace(/^www\./, "");
  const known = KNOWN_SOURCE_DOMAINS.find((d) => d.match.test(host));
  return known ? known.name : rawSource; // unrecognized domain — show the raw URL rather than guess
}

export interface AttributionSummary {
  firstTouchChannel: string;
  firstTouchSource: string;
  firstTouchCampaign: string | null;
  firstTouchMedium: string | null;
  firstTouchContent: string | null;
  firstTouchTerm: string | null;
  firstTouchDate: string; // YYYY-MM-DD
  firstTouchGclid: string | null;
  firstTouchFbclid: string | null;
  firstTouchMsclkid: string | null;
  firstTouchLiFatId: string | null;
  firstTouchReferrer: string | null;
  firstTouchLandingPage: string | null;
  lastTouchChannel: string;
  lastTouchSource: string;
  lastTouchCampaign: string | null;
  lastTouchMedium: string | null;
  lastTouchContent: string | null;
  lastTouchTerm: string | null;
  lastTouchDate: string; // YYYY-MM-DD
  lastTouchGclid: string | null;
  lastTouchFbclid: string | null;
  lastTouchMsclkid: string | null;
  lastTouchLiFatId: string | null;
  lastTouchReferrer: string | null;
  lastTouchLandingPage: string | null;
  touchpointCount: number;
  summaryText: string;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function describe(tp: Touchpoint): string {
  const label = CHANNEL_LABELS[tp.channel] || tp.channel;
  const detail = tp.title || tp.url || tp.campaign || tp.source;
  return `${toDateOnly(tp.occurredAt)} — ${label}: ${detail}`;
}

/**
 * Turns an ordered (oldest-first) list of touchpoints into the compact
 * summary written onto Pipedrive custom fields. Kept deliberately simple
 * (first touch, last touch, count, plain-text log) rather than a weighted
 * attribution model — see README "What's deliberately out of scope".
 */
export function buildAttributionSummary(touchpoints: Touchpoint[]): AttributionSummary | null {
  if (touchpoints.length === 0) return null;

  const first = touchpoints[0];
  const last = touchpoints[touchpoints.length - 1];

  return {
    firstTouchChannel: CHANNEL_LABELS[first.channel] || first.channel,
    firstTouchSource: first.source,
    firstTouchCampaign: first.campaign,
    firstTouchMedium: first.medium,
    firstTouchContent: first.content,
    firstTouchTerm: first.term,
    firstTouchDate: toDateOnly(first.occurredAt),
    firstTouchGclid: first.gclid,
    firstTouchFbclid: first.fbclid,
    firstTouchMsclkid: first.msclkid,
    firstTouchLiFatId: first.liFatId,
    firstTouchReferrer: first.referrer,
    firstTouchLandingPage: first.url,
    lastTouchChannel: CHANNEL_LABELS[last.channel] || last.channel,
    lastTouchSource: last.source,
    lastTouchCampaign: last.campaign,
    lastTouchMedium: last.medium,
    lastTouchContent: last.content,
    lastTouchTerm: last.term,
    lastTouchDate: toDateOnly(last.occurredAt),
    lastTouchGclid: last.gclid,
    lastTouchFbclid: last.fbclid,
    lastTouchMsclkid: last.msclkid,
    lastTouchLiFatId: last.liFatId,
    lastTouchReferrer: last.referrer,
    lastTouchLandingPage: last.url,
    touchpointCount: touchpoints.length,
    summaryText: touchpoints.map(describe).join("\n"),
  };
}

/**
 * Attribution as it stood strictly *before* a given cutoff — used to
 * freeze onto a Deal at the moment it's created, so a prospect's second
 * or third deal doesn't retroactively inherit touchpoints that happened
 * after the first deal already closed.
 */
export function buildAttributionAsOf(touchpoints: Touchpoint[], cutoff: Date): AttributionSummary | null {
  return buildAttributionSummary(touchpoints.filter((t) => t.occurredAt.getTime() <= cutoff.getTime()));
}
