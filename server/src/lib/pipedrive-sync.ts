import { db, Identity, Tenant, Touchpoint } from "../db";
import { buildAttributionSummary, buildAttributionAsOf } from "./attribution";
import { updatePersonCustomFields, updateDealCustomFields, createNote, createActivity } from "./pipedrive";
import { journeyLinkUrl } from "./journey-link";

/**
 * Adds a field to a custom_fields payload only if this tenant's field map
 * actually has a key for it — a tenant onboarded before a given field
 * existed (personFieldMap/dealFieldMap cached from an earlier
 * setupPipedriveFields run) won't have it yet, and `m[missingKey]` would
 * be `undefined`, which as an object key would coerce to the *string*
 * "undefined" and silently write into a field that doesn't exist. Re-run
 * `npm run setup:pipedrive -- --tenant <slug>` (or the self-serve signup
 * flow) to pick up newly added fields.
 */
function setIfMapped(
  fields: Record<string, string | number>,
  map: Record<string, string>,
  localKey: string,
  value: string | number | null | undefined
) {
  const pipedriveKey = map[localKey];
  if (!pipedriveKey) return;
  fields[pipedriveKey] = value ?? "";
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Pushes the living, full-history attribution summary onto the Person's
 * custom fields. Called after every touchpoint is recorded (see
 * lib/identity.ts). Best-effort: if this tenant hasn't set a Pipedrive API
 * token, or hasn't run `npm run setup:pipedrive` yet (no field map on
 * their tenant row), this is a silent no-op rather than a hard failure —
 * tracking and the panel API should keep working before the custom-fields
 * path is configured for a given client.
 */
export async function syncPersonAttribution(tenant: Tenant, identity: Identity): Promise<void> {
  if (!identity.pipedrivePersonId) return;
  if (!tenant.pipedriveApiToken) return;
  if (!tenant.personFieldMap) return;

  try {
    const touchpoints = await db.touchpoint.findMany({
      where: { tenantId: tenant.id, identityId: identity.id },
      orderBy: { occurredAt: "asc" },
    });
    const summary = buildAttributionSummary(touchpoints);
    if (!summary) return;

    const m = tenant.personFieldMap;
    const fields: Record<string, string | number> = {
      [m.first_touch_channel]: summary.firstTouchChannel,
      [m.first_touch_source]: summary.firstTouchSource,
      [m.first_touch_campaign]: summary.firstTouchCampaign ?? "",
      [m.first_touch_date]: summary.firstTouchDate,
      [m.last_touch_channel]: summary.lastTouchChannel,
      [m.last_touch_source]: summary.lastTouchSource,
      [m.last_touch_date]: summary.lastTouchDate,
      [m.touchpoint_count]: summary.touchpointCount,
      [m.journey_summary]: summary.summaryText,
    };
    setIfMapped(fields, m, "first_touch_gclid", summary.firstTouchGclid);
    setIfMapped(fields, m, "first_touch_fbclid", summary.firstTouchFbclid);
    setIfMapped(fields, m, "first_touch_msclkid", summary.firstTouchMsclkid);
    setIfMapped(fields, m, "first_touch_referrer", summary.firstTouchReferrer);
    setIfMapped(fields, m, "first_touch_landing_page", summary.firstTouchLandingPage);
    setIfMapped(fields, m, "last_touch_gclid", summary.lastTouchGclid);
    setIfMapped(fields, m, "last_touch_fbclid", summary.lastTouchFbclid);
    setIfMapped(fields, m, "last_touch_msclkid", summary.lastTouchMsclkid);
    setIfMapped(fields, m, "last_touch_referrer", summary.lastTouchReferrer);
    setIfMapped(fields, m, "last_touch_landing_page", summary.lastTouchLandingPage);
    setIfMapped(fields, m, "first_touch_medium", summary.firstTouchMedium);
    setIfMapped(fields, m, "first_touch_term", summary.firstTouchTerm);
    setIfMapped(fields, m, "first_touch_content", summary.firstTouchContent);
    setIfMapped(fields, m, "last_touch_medium", summary.lastTouchMedium);
    setIfMapped(fields, m, "last_touch_term", summary.lastTouchTerm);
    setIfMapped(fields, m, "last_touch_content", summary.lastTouchContent);
    // Deterministic for a given tenant+identity (same HMAC input every
    // time), so recomputing it on every sync is fine — it never actually
    // changes once PUBLIC_BASE_URL is set. Guarded with an `if`, not
    // setIfMapped's own null -> "" coercion: PUBLIC_BASE_URL being unset
    // should leave this field untouched (skip it entirely this sync),
    // not actively blank out a link that synced correctly before.
    const journeyUrl = journeyLinkUrl(tenant, identity.id);
    if (journeyUrl) setIfMapped(fields, m, "view_journey", journeyUrl);
    await updatePersonCustomFields(tenant.pipedriveApiToken, identity.pipedrivePersonId, fields);
  } catch (err) {
    // Never let a Pipedrive sync failure break tracking ingestion.
    console.error(`[pipedrive-sync] syncPersonAttribution failed for tenant ${tenant.id}:`, err);
  }
}

/**
 * Freezes a first-touch/last-touch snapshot onto a newly created Deal, so
 * a prospect's later deals don't inherit or overwrite this one's
 * attribution story. Called from the Pipedrive webhook handler on
 * deal-created events (see routes/webhooks.ts).
 */
export async function freezeDealAttribution(
  tenant: Tenant,
  params: {
    dealId: number;
    pipedrivePersonId: number;
    dealCreatedAt: Date;
  }
): Promise<void> {
  if (!tenant.pipedriveApiToken) return;
  if (!tenant.dealFieldMap) return;

  try {
    const identity = await db.identity.findUnique({
      where: { tenantId: tenant.id, pipedrivePersonId: params.pipedrivePersonId },
    });
    if (!identity) return;

    const touchpoints = await db.touchpoint.findMany({
      where: { tenantId: tenant.id, identityId: identity.id },
      orderBy: { occurredAt: "asc" },
    });
    const summary = buildAttributionAsOf(touchpoints, params.dealCreatedAt);
    if (!summary) return;

    const firstTouchDate = new Date(summary.firstTouchDate);
    const daysToCreate = Math.max(
      0,
      Math.round((params.dealCreatedAt.getTime() - firstTouchDate.getTime()) / (24 * 60 * 60 * 1000))
    );

    const m = tenant.dealFieldMap;
    const fields: Record<string, string | number> = {
      [m.deal_first_touch_channel]: summary.firstTouchChannel,
      [m.deal_first_touch_source]: summary.firstTouchSource,
      [m.deal_first_touch_campaign]: summary.firstTouchCampaign ?? "",
      [m.deal_touchpoint_count]: summary.touchpointCount,
      [m.deal_days_to_create]: daysToCreate,
    };
    setIfMapped(fields, m, "deal_first_touch_gclid", summary.firstTouchGclid);
    setIfMapped(fields, m, "deal_first_touch_fbclid", summary.firstTouchFbclid);
    setIfMapped(fields, m, "deal_first_touch_msclkid", summary.firstTouchMsclkid);
    setIfMapped(fields, m, "deal_first_touch_referrer", summary.firstTouchReferrer);
    setIfMapped(fields, m, "deal_first_touch_landing_page", summary.firstTouchLandingPage);
    setIfMapped(fields, m, "deal_last_touch_gclid", summary.lastTouchGclid);
    setIfMapped(fields, m, "deal_last_touch_fbclid", summary.lastTouchFbclid);
    setIfMapped(fields, m, "deal_last_touch_msclkid", summary.lastTouchMsclkid);
    setIfMapped(fields, m, "deal_last_touch_referrer", summary.lastTouchReferrer);
    setIfMapped(fields, m, "deal_last_touch_landing_page", summary.lastTouchLandingPage);
    setIfMapped(fields, m, "deal_first_touch_medium", summary.firstTouchMedium);
    setIfMapped(fields, m, "deal_first_touch_term", summary.firstTouchTerm);
    setIfMapped(fields, m, "deal_first_touch_content", summary.firstTouchContent);
    setIfMapped(fields, m, "deal_last_touch_medium", summary.lastTouchMedium);
    setIfMapped(fields, m, "deal_last_touch_term", summary.lastTouchTerm);
    setIfMapped(fields, m, "deal_last_touch_content", summary.lastTouchContent);
    // Same link as the Person's own "AS: View Journey" field — see the
    // guard comment on that setIfMapped call above.
    const dealJourneyUrl = journeyLinkUrl(tenant, identity.id);
    if (dealJourneyUrl) setIfMapped(fields, m, "deal_view_journey", dealJourneyUrl);
    await updateDealCustomFields(tenant.pipedriveApiToken, params.dealId, fields);
  } catch (err) {
    console.error(`[pipedrive-sync] freezeDealAttribution failed for tenant ${tenant.id}:`, err);
  }
}

/**
 * Pushes one of the two deal-lifecycle touchpoint-count milestones (see
 * lib/deal-milestones.ts) onto the Deal's own custom fields — the
 * Pipedrive-side mirror of what db.identity.setDealMilestone already
 * wrote to our own DB, so a rep looking at the Deal record itself can
 * see "how much activity got this deal here" without opening the
 * dashboard. Called right alongside that DB write, once each, from
 * routes/webhooks.ts's deal-created and deal-won blocks. Best-effort and
 * silent on any precondition not being met, same philosophy as
 * freezeDealAttribution: a Pipedrive write failing here should never
 * break webhook processing or leave the DB and Pipedrive disagreeing in
 * a way that surfaces as a 500.
 */
export async function syncDealMilestoneField(
  tenant: Tenant,
  dealId: number,
  localKey: "deal_lead_to_deal_touchpoints" | "deal_deal_to_won_touchpoints",
  value: number
): Promise<void> {
  if (!tenant.pipedriveApiToken) return;
  if (!tenant.dealFieldMap) return;

  try {
    const fields: Record<string, string | number> = {};
    setIfMapped(fields, tenant.dealFieldMap, localKey, value);
    // Tenant's cached field map predates this field (see setIfMapped's
    // doc comment) — nothing to write until `npm run setup:pipedrive` is
    // re-run for them.
    if (Object.keys(fields).length === 0) return;
    await updateDealCustomFields(tenant.pipedriveApiToken, dealId, fields);
  } catch (err) {
    console.error(`[pipedrive-sync] syncDealMilestoneField (${localKey}) failed for tenant ${tenant.id}:`, err);
  }
}

// A page visit under this length rarely reflects real interest — without
// a floor, every stray click/bounce would add its own Note or Activity to
// a Person's Pipedrive timeline, which would make the feature actively
// annoying rather than useful. This is separate from (and higher than)
// automated-sales-tracker.js's own 250ms floor for even bothering to
// report a duration at all.
const MIN_LOGGABLE_VISIT_MS = 3000;

/**
 * Per-tenant opt-in (see `pipedriveVisitLogging` on the Tenant row, set
 * via the dashboard): writes each individual website visit — page +
 * time on page — onto the linked Person (and their deal, if there's
 * exactly one) as either a Note or an Activity, however that tenant
 * prefers. Called from routes/track.ts's /track/duration handler, since
 * a touchpoint's duration (the whole point of this feature) is never
 * known until that follow-up call arrives — never at /track itself.
 *
 * Best-effort and silent on any precondition not being met (no
 * pipedrivePersonId yet, feature off, no token) — same philosophy as
 * syncPersonAttribution: this is a nice-to-have enrichment, never
 * something that should make tracking itself less reliable.
 */
export async function logWebsiteVisit(tenant: Tenant, identity: Identity, touchpoint: Touchpoint): Promise<void> {
  if (!identity.pipedrivePersonId) return;
  if (!tenant.pipedriveApiToken) return;
  if (tenant.pipedriveVisitLogging === "off") return;
  if (!touchpoint.durationMs || touchpoint.durationMs < MIN_LOGGABLE_VISIT_MS) return;

  try {
    // Only attach to a Deal when there's exactly one linked — with
    // several open deals for the same contact, guessing which one this
    // particular page visit is "about" would be more misleading than
    // just leaving it off the Deal and still showing it on the Person.
    const dealIds = identity.pipedriveDealIds.split(",").filter(Boolean);
    const dealId = dealIds.length === 1 ? Number(dealIds[0]) : undefined;

    const pageLabel = touchpoint.title || touchpoint.url || "a page";
    const duration = formatDuration(touchpoint.durationMs);
    const sourceLine = touchpoint.campaign
      ? `${touchpoint.source} (campaign: ${touchpoint.campaign})`
      : touchpoint.source;
    const subject = `Website visit: ${pageLabel}`;

    if (tenant.pipedriveVisitLogging === "activities") {
      const noteLines = [touchpoint.url ? `Visited: ${touchpoint.url}` : null, `Time on page: ${duration}`, `Source: ${sourceLine}`].filter(
        Boolean
      );
      await createActivity(tenant.pipedriveApiToken, {
        subject,
        note: noteLines.join("\n"),
        personId: identity.pipedrivePersonId,
        dealId,
        done: true,
      });
    } else {
      const contentLines = [
        `<b>${subject}</b>`,
        touchpoint.url ? `Visited: ${touchpoint.url}` : null,
        `Time on page: ${duration}`,
        `Source: ${sourceLine}`,
      ].filter(Boolean);
      await createNote(tenant.pipedriveApiToken, {
        content: contentLines.join("<br>"),
        personId: identity.pipedrivePersonId,
        dealId,
      });
    }
  } catch (err) {
    console.error(`[pipedrive-sync] logWebsiteVisit failed for tenant ${tenant.id}:`, err);
  }
}
