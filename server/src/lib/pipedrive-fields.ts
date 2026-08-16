import { PipedriveFieldType } from "./pipedrive";

/**
 * Local, stable names for each field we manage — used everywhere in our
 * code instead of Pipedrive's account-specific 40-character hash keys.
 * The hash keys (assigned by Pipedrive when the field is first created,
 * separately per tenant since each client has their own Pipedrive
 * account) are resolved once by `npm run setup:pipedrive -- --tenant
 * <slug>` and cached on that tenant's row (tenants.personFieldMap /
 * tenants.dealFieldMap) so we don't recreate fields on every run.
 */
export interface FieldDef {
  localKey: string;
  name: string;
  field_type: PipedriveFieldType;
}

// Living, current attribution — kept up to date on the Person every time
// a new touchpoint comes in. This is the "whole history so far" view.
export const PERSON_FIELDS: FieldDef[] = [
  { localKey: "first_touch_channel", name: "AS: First Touch Channel", field_type: "varchar" },
  { localKey: "first_touch_source", name: "AS: First Touch Source", field_type: "varchar" },
  { localKey: "first_touch_campaign", name: "AS: First Touch Campaign", field_type: "varchar" },
  { localKey: "first_touch_date", name: "AS: First Touch Date", field_type: "date" },
  { localKey: "last_touch_channel", name: "AS: Last Touch Channel", field_type: "varchar" },
  { localKey: "last_touch_source", name: "AS: Last Touch Source", field_type: "varchar" },
  { localKey: "last_touch_date", name: "AS: Last Touch Date", field_type: "date" },
  { localKey: "touchpoint_count", name: "AS: Touchpoint Count", field_type: "double" },
  { localKey: "journey_summary", name: "AS: Journey Summary", field_type: "text" },
  // Ad-platform click IDs + referrer/landing page — added after the base
  // set above; kept as their own group so it's obvious in Pipedrive's
  // field list which ones are the newer addition. varchar for the click
  // IDs (short opaque tokens), text for referrer/landing page since a
  // full URL can run past varchar's typical length ceiling.
  { localKey: "first_touch_gclid", name: "AS: First Touch GCLID", field_type: "varchar" },
  { localKey: "first_touch_fbclid", name: "AS: First Touch FBCLID", field_type: "varchar" },
  { localKey: "first_touch_msclkid", name: "AS: First Touch MSCLKID", field_type: "varchar" },
  { localKey: "first_touch_referrer", name: "AS: First Touch Referrer", field_type: "text" },
  { localKey: "first_touch_landing_page", name: "AS: First Touch Landing Page", field_type: "text" },
  { localKey: "last_touch_gclid", name: "AS: Last Touch GCLID", field_type: "varchar" },
  { localKey: "last_touch_fbclid", name: "AS: Last Touch FBCLID", field_type: "varchar" },
  { localKey: "last_touch_msclkid", name: "AS: Last Touch MSCLKID", field_type: "varchar" },
  { localKey: "last_touch_referrer", name: "AS: Last Touch Referrer", field_type: "text" },
  { localKey: "last_touch_landing_page", name: "AS: Last Touch Landing Page", field_type: "text" },
  // Remaining UTM parameters — source and campaign already had their own
  // fields above; medium/term/content were captured in our own DB and
  // visible in the dashboard but never made it to Pipedrive itself until
  // now. varchar for all three: medium is a short label (cpc/social/
  // email), term is a search keyword, content is an ad/variant name —
  // none of these run long enough to need `text`.
  { localKey: "first_touch_medium", name: "AS: First Touch Medium", field_type: "varchar" },
  { localKey: "first_touch_term", name: "AS: First Touch Term", field_type: "varchar" },
  { localKey: "first_touch_content", name: "AS: First Touch Content", field_type: "varchar" },
  { localKey: "last_touch_medium", name: "AS: Last Touch Medium", field_type: "varchar" },
  { localKey: "last_touch_term", name: "AS: Last Touch Term", field_type: "varchar" },
  { localKey: "last_touch_content", name: "AS: Last Touch Content", field_type: "varchar" },
  // A clickable link to this Person's full journey — the interim
  // stand-in for a real in-Pipedrive popup (see lib/journey-link.ts).
  // `text`, not `varchar`, since the signed URL runs past varchar's
  // practical length ceiling (same reasoning as the referrer/landing
  // page fields above).
  { localKey: "view_journey", name: "AS: View Journey", field_type: "text" },
];

// Frozen at the moment each Deal is created — "what caused THIS deal",
// so a contact's second deal a year later doesn't inherit the first
// deal's attribution or vice versa. See lib/attribution.ts buildAttributionAsOf.
export const DEAL_FIELDS: FieldDef[] = [
  { localKey: "deal_first_touch_channel", name: "AS: First Touch Channel (at deal creation)", field_type: "varchar" },
  { localKey: "deal_first_touch_source", name: "AS: First Touch Source (at deal creation)", field_type: "varchar" },
  { localKey: "deal_first_touch_campaign", name: "AS: First Touch Campaign (at deal creation)", field_type: "varchar" },
  { localKey: "deal_touchpoint_count", name: "AS: Touchpoints Before Deal Created", field_type: "double" },
  { localKey: "deal_days_to_create", name: "AS: Days From First Touch To Deal Created", field_type: "double" },
  // Same click-ID/referrer/landing-page group as Person, both first- and
  // last-touch as-of the moment this deal was created (unlike the fields
  // above, which are first-touch only — see freezeDealAttribution).
  { localKey: "deal_first_touch_gclid", name: "AS: First Touch GCLID (at deal creation)", field_type: "varchar" },
  { localKey: "deal_first_touch_fbclid", name: "AS: First Touch FBCLID (at deal creation)", field_type: "varchar" },
  { localKey: "deal_first_touch_msclkid", name: "AS: First Touch MSCLKID (at deal creation)", field_type: "varchar" },
  { localKey: "deal_first_touch_referrer", name: "AS: First Touch Referrer (at deal creation)", field_type: "text" },
  { localKey: "deal_first_touch_landing_page", name: "AS: First Touch Landing Page (at deal creation)", field_type: "text" },
  { localKey: "deal_last_touch_gclid", name: "AS: Last Touch GCLID (at deal creation)", field_type: "varchar" },
  { localKey: "deal_last_touch_fbclid", name: "AS: Last Touch FBCLID (at deal creation)", field_type: "varchar" },
  { localKey: "deal_last_touch_msclkid", name: "AS: Last Touch MSCLKID (at deal creation)", field_type: "varchar" },
  { localKey: "deal_last_touch_referrer", name: "AS: Last Touch Referrer (at deal creation)", field_type: "text" },
  { localKey: "deal_last_touch_landing_page", name: "AS: Last Touch Landing Page (at deal creation)", field_type: "text" },
  // Same medium/term/content group as Person, above.
  { localKey: "deal_first_touch_medium", name: "AS: First Touch Medium (at deal creation)", field_type: "varchar" },
  { localKey: "deal_first_touch_term", name: "AS: First Touch Term (at deal creation)", field_type: "varchar" },
  { localKey: "deal_first_touch_content", name: "AS: First Touch Content (at deal creation)", field_type: "varchar" },
  { localKey: "deal_last_touch_medium", name: "AS: Last Touch Medium (at deal creation)", field_type: "varchar" },
  { localKey: "deal_last_touch_term", name: "AS: Last Touch Term (at deal creation)", field_type: "varchar" },
  { localKey: "deal_last_touch_content", name: "AS: Last Touch Content (at deal creation)", field_type: "varchar" },
  // Deal-lifecycle milestones — how much prospect activity happened in
  // each stage of the journey. Lead-to-Deal is written once, right when
  // the deal is created; Deal-to-Won is written once, the moment the
  // deal flips to won (and stays blank until then). See
  // lib/deal-milestones.ts for the counting logic and
  // routes/webhooks.ts for where these get pushed — same underlying
  // numbers already shown on the dashboard and in the CSV export, now
  // also on the Deal record itself so a rep doesn't need to leave
  // Pipedrive to see them.
  { localKey: "deal_lead_to_deal_touchpoints", name: "AS: Touchpoints — Lead to Deal", field_type: "double" },
  { localKey: "deal_deal_to_won_touchpoints", name: "AS: Touchpoints — Deal to Won", field_type: "double" },
  // Same "View full journey" link as the Person field above — points at
  // the same identity's same full journey (not scoped to just this
  // deal), since a rep looking at a Deal record still wants the whole
  // story, not just what happened after this specific deal was created.
  { localKey: "deal_view_journey", name: "AS: View Journey", field_type: "text" },
];
