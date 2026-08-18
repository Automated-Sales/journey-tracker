import { Router } from "express";
import { db, Tenant, Identity } from "../db";
import { recordTouchpoint, mergeIdentities } from "../lib/identity";
import { freezeDealAttribution, syncPersonAttribution, freezeLeadAttribution, syncDealMilestoneField } from "../lib/pipedrive-sync";
import { requireTenant, requireTenantSecret } from "./tenant-middleware";
import { getDeal, getPerson, listStages } from "../lib/pipedrive";
import { countTouchpointsUpTo, countTouchpointsBetween } from "../lib/deal-milestones";

export const webhooksRouter = Router({ mergeParams: true });

/**
 * EMAIL ENGAGEMENT
 * ------------------------------------------------------------------
 * Generic webhook endpoint for a client's email/marketing tool
 * (Mailchimp, ActiveCampaign, HubSpot, Klaviyo, etc). Each of these
 * tools has its own payload shape — normalize it here rather than in
 * every caller.
 *
 * Configure this URL as a webhook in the client's ESP for "email
 * opened", "link clicked", and "reply received" events — the exact URL
 * is printed by `npm run add-tenant` for each client:
 *   POST https://<your-host>/t/<tenant-slug>/webhooks/email?secret=<that tenant's webhookSecret>
 *
 * Expected normalized body (adapt the mapping block below to the ESP):
 *   { email, event: "open"|"click"|"reply", campaignName, url?, occurredAt? }
 */
webhooksRouter.post("/webhooks/email", requireTenant, requireTenantSecret("secret", "webhookSecret"), async (req, res) => {
  try {
    const tenant = req.tenant!;
    const body = req.body || {};

    // --- Mapping block: adjust to match this client's ESP payload shape ---
    const email = body.email || body.recipient || body?.data?.email;
    const eventType = (body.event || body.type || "open").toLowerCase(); // open | click | reply
    const campaignName = body.campaignName || body.campaign_name || body?.data?.campaign_name || null;
    const url = body.url || null;
    const source = body.source || "email";
    // -----------------------------------------------------------------

    if (!email) return res.status(400).json({ error: "no email found in payload" });

    const channel =
      eventType === "click" ? "email_click" : eventType === "reply" ? "email_reply" : "email_open";

    const { identity } = await recordTouchpoint(tenant, {
      channel,
      source,
      campaign: campaignName,
      url,
      email,
      occurredAt: body.occurredAt || new Date(),
    });

    res.json({ ok: true, identityId: identity.id });
  } catch (err: any) {
    console.error("[/webhooks/email]", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * AD PLATFORM CONVERSIONS
 * ------------------------------------------------------------------
 * LinkedIn Ads and Google Ads don't webhook you a "this exact person
 * clicked" event with an email address — clicks are captured client-side
 * by the tracking snippet (see /api/track, which stores gclid / li_fat_id
 * on an anonymous touchpoint). This endpoint is for the *offline
 * conversion* side: once you know a click ID converted to a real
 * prospect (e.g. nightly job pulling Google Ads / LinkedIn Ads
 * conversion reports, or a CRM-triggered offline conversion upload),
 * post it here to attach campaign metadata to the identity.
 *
 * Body: { clickId, email?, campaign?, source: "google_ads"|"linkedin_ads", occurredAt? }
 */
webhooksRouter.post("/webhooks/ads", requireTenant, requireTenantSecret("secret", "webhookSecret"), async (req, res) => {
  try {
    const tenant = req.tenant!;
    const { clickId, email, campaign, source, occurredAt } = req.body || {};
    if (!clickId && !email) {
      return res.status(400).json({ error: "clickId or email is required" });
    }

    const { identity } = await recordTouchpoint(tenant, {
      channel: "ad_click",
      source: source || "ads",
      campaign: campaign || null,
      clickId: clickId || null,
      email: email || null,
      occurredAt: occurredAt || new Date(),
    });

    res.json({ ok: true, identityId: identity.id });
  } catch (err: any) {
    console.error("[/webhooks/ads]", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PIPEDRIVE ACTIVITY / STAGE SYNC
 * ------------------------------------------------------------------
 * Register this as a webhook in the client's own Pipedrive account
 * (Settings > Tools > Webhooks) for:
 *   - person.create / person.update  (captures the "known" identity + email)
 *   - deal.update                    (captures stage changes — the "last click"
 *                                      moment: which deal stage/pipeline closed it)
 *   - activity.create                (captures calls, meetings, tasks reps log)
 *   - note.create                    (captures manually logged context)
 *
 * URL (printed per-client by `npm run add-tenant`):
 *   https://<your-host>/t/<tenant-slug>/webhooks/pipedrive?secret=<that tenant's webhookSecret>
 * Pipedrive's webhook payload (v2) wraps the changed object in `data` and
 * tells you the event in `meta.action` / `meta.entity`.
 */
/**
 * Pulls a Person's email out of a webhook payload's `data` object.
 * Two separate reasons this can't be a one-liner:
 *
 * 1. Field name: Pipedrive's v1-style payloads use `email` (an array of
 *    { value, primary }); v2-style payloads (the "Automated webhooks" /
 *    modern Webhooks UI, all-actions subscriptions) use `emails` instead,
 *    mirroring the v2 /persons/{id} API's own shape. Different accounts
 *    can send either, so both are checked.
 * 2. Presence: Pipedrive's "updated" events send a PARTIAL diff — only
 *    the fields that actually changed are present in `data`. Editing a
 *    Person's last name, for instance, arrives with no email field at
 *    all (it didn't change), not an empty one. So the caller must treat
 *    a null return as "unknown this time," never as "cleared."
 */
function extractPersonEmail(data: any): string | null {
  const raw = data?.email ?? data?.emails;
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const primary = raw.find((e: any) => e?.primary) || raw[0];
    return primary?.value ?? null;
  }
  return typeof raw === "string" ? raw : null;
}

// Same shape/extraction logic as extractPersonEmail above — Pipedrive
// represents phones the same way it represents emails (an array of
// {label, value, primary} objects on both the webhook payload and the
// live v2 Person record).
function extractPersonPhone(data: any): string | null {
  const raw = data?.phone ?? data?.phones;
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const primary = raw.find((p: any) => p?.primary) || raw[0];
    return primary?.value ?? null;
  }
  return typeof raw === "string" ? raw : null;
}

/**
 * Fixes the "(anonymous)" dashboard rows that have a real Pipedrive link
 * (#12345) sitting right next to them — those show up whenever the
 * FIRST event we ever see for a contact is a deal/activity/note/lead
 * webhook rather than person.create/person.change or a website sign-up.
 * Those handlers only ever have a bare pipedrivePersonId to go on (see
 * each call site below), never an email, so mergeIdentities creates the
 * identity without one — and since email only ever gets backfilled from
 * a LATER person.create/change event, an identity whose contact record
 * was created in Pipedrive before this integration went live (or was
 * never edited again afterward) could stay "(anonymous)" forever despite
 * every touchpoint pointing at a named, known Person.
 *
 * Also captures name/phone from the same fetch, as a fallback identifier
 * for the dashboard's Contact column when email itself turns out to be
 * genuinely absent from Pipedrive too — real for some clients (e.g. a
 * lead form that only asks for a phone number). See db.ts's ensureColumn
 * comment for why phone is display-only, never a matching/merge key.
 *
 * This does one live GET /persons/{id} call, but only when the identity
 * doesn't already have an email — for most contacts (created after
 * go-live, or ever edited), a person.change webhook already supplied
 * the email (and, since that handler now also captures it directly, the
 * name/phone) up front and this is a no-op. A contact whose Person
 * record genuinely has no email in Pipedrive re-attempts this fetch on
 * every subsequent deal/activity/note/lead event for them — a
 * deliberate simplification rather than tracking "we already tried and
 * it's genuinely empty" with its own column; acceptable given
 * Pipedrive's rate limits are generous relative to typical webhook
 * volume, but worth revisiting if it ever shows up as a real cost.
 */
async function backfillContactFromPipedrive(tenant: Tenant, identity: Identity, personId: number): Promise<Identity> {
  if (identity.email || !tenant.pipedriveApiToken) return identity;
  try {
    const person = await getPerson(tenant.pipedriveApiToken, personId);
    const email = extractPersonEmail(person);
    const name = typeof person?.name === "string" && person.name.trim() ? person.name.trim() : null;
    const phone = extractPersonPhone(person);
    if (email || name || phone) {
      return await mergeIdentities(tenant, {
        pipedrivePersonId: personId,
        email: email ?? undefined,
        name: name ?? undefined,
        phone: phone ?? undefined,
      });
    }
  } catch (err) {
    console.error(`[webhooks] backfillContactFromPipedrive failed for tenant ${tenant.id}, person ${personId}:`, err);
  }
  return identity;
}

/**
 * Captures the tenant's configured segment field (see db.ts's
 * Tenant.segmentFieldKey doc comment, e.g. Johari's Label) from a
 * Deal/Lead webhook payload. UNLIKE backfillContactFromPipedrive above,
 * this always overwrites with whatever's on THIS payload — a segment
 * value represents the CURRENT state, not a permanent freeze, so an
 * edit in Pipedrive should show up here too. Called from the person,
 * deal, AND lead handlers below — Labels (and similar segmentation
 * fields) can live on any of Person/Deal/Lead in Pipedrive, each with
 * their own separate field key, so this just needs to be everywhere and
 * let the "field not on this payload" no-op below sort out which
 * handler(s) actually have it. Confirmed in practice: Johari's own
 * Label field turned out to be on the Person record, not Deal/Lead as
 * first assumed — a no-op whenever the tenant hasn't configured a
 * segment field, or this particular payload doesn't include it
 * (Pipedrive's partial-diff webhooks — see extractPersonEmail's doc
 * comment — commonly omit fields that didn't just change).
 *
 * Pipedrive represents this kind of field's value as either a single ID
 * (string/number) or, for multi-select fields, an array of IDs —
 * genuinely unverified which shape Label specifically uses on a live
 * webhook payload (same caution as this session's earlier, since-removed
 * listDealLabelOptions exploration) — handled defensively for both.
 */
async function captureSegmentValue(tenant: Tenant, identity: Identity, data: any, entity: "person" | "deal"): Promise<void> {
  if (!tenant.segmentFieldKey) return;
  // Composite "person::rawkey" / "deal::rawkey" — see
  // routes/portal.ts's listSegmentableFields doc comment for why this
  // prefix exists (Person and Deal can both have a field literally
  // keyed "label"). Only act when the configured field's entity
  // matches whichever webhook is currently being processed — Leads
  // share Deal field definitions in Pipedrive (same convention already
  // used throughout this file for Lead-level attribution), so a Lead
  // webhook is treated as "deal" here too.
  const separatorIndex = tenant.segmentFieldKey.indexOf("::");
  if (separatorIndex === -1) return; // malformed/legacy value from before this prefix existed — treat as unconfigured rather than guessing
  const configuredEntity = tenant.segmentFieldKey.slice(0, separatorIndex);
  const rawKey = tenant.segmentFieldKey.slice(separatorIndex + 2);
  if (configuredEntity !== entity) return;
  const raw = data[rawKey];
  if (raw === undefined || raw === null) return;
  const value = Array.isArray(raw) ? raw.map(String).join(",") : String(raw);
  if (identity.segmentValue === value) return; // no-op, avoid a pointless write+persist
  await db.identity.setSegmentValue({ where: { tenantId: tenant.id, id: identity.id }, segmentValue: value || null });
}

/**
 * Per-tenant configured fallback source (see db.ts's Tenant interface
 * doc comment on leadSourceFieldKey) — ONLY applied when this identity
 * has zero touchpoints of any kind, i.e. our own tracking never saw
 * this person at all. Real tracked data — even a single anonymous ad
 * click or page view — always wins; this never overrides or competes
 * with it.
 *
 * Called from BOTH the Lead handler AND the Deal "created" handler
 * below — originally this only ran on Lead creation, but plenty of
 * Pipedrive workflows create Deals directly without ever going through
 * the Leads Inbox at all, meaning the fallback never got a chance to
 * fire for them; the first (and only) touchpoint such a contact ever
 * got was a generic "pipedrive_stage_change" one once their Deal
 * started moving, which is a real event but not a SOURCE — it says
 * nothing about where the contact originally came from, unlike this
 * fallback field. Safe to call from both: Leads and Deals share the
 * same custom-field structure in Pipedrive, so the same configured
 * field key resolves correctly off either payload, and the "zero
 * touchpoints so far" guard means whichever event happens to arrive
 * first is the one that gets to apply it — a Lead created before its
 * Deal still gets first crack, same behavior as before this change.
 */
async function applyLeadSourceFallback(tenant: Tenant, identity: Identity, data: any, occurredAt: Date): Promise<void> {
  if (!tenant.leadSourceFieldKey) return;
  const existingTouchpoints = await db.touchpoint.findMany({
    where: { tenantId: tenant.id, identityId: identity.id },
  });
  if (existingTouchpoints.length > 0) return;
  const fieldValue = data[tenant.leadSourceFieldKey];
  if (typeof fieldValue !== "string" || !fieldValue.trim()) return;
  await db.touchpoint.create({
    data: {
      tenantId: tenant.id,
      identityId: identity.id,
      channel: "lead_source_field",
      // The raw value as-is, whatever shape it happens to be for this
      // tenant (a URL, a plain label, etc) — deliberately not
      // parsed/reformatted, since its structure is entirely
      // tenant-specific and unknown to us in general.
      source: fieldValue.trim(),
      title: `Lead source (${tenant.leadSourceFieldLabel || "configured field"}): ${fieldValue.trim()}`,
      metadata: JSON.stringify({ leadSourceFieldKey: tenant.leadSourceFieldKey }),
      occurredAt,
    },
  });
  // Immediate backfill, same "push now rather than wait for the next
  // unrelated event" pattern used elsewhere in this file — this
  // identity's Person-level AS: fields would otherwise stay blank
  // until some later, unrelated webhook happens to re-trigger a sync.
  await syncPersonAttribution(tenant, identity).catch((err) =>
    console.error(`[webhooks] syncPersonAttribution after lead-source-fallback failed for tenant ${tenant.id}:`, err)
  );
}

/**
 * Resolves a Pipedrive stage_id into its readable name for the "Deal
 * stage by source" report — see db.ts's Tenant.stageNameMap doc comment
 * for the self-healing cache design. Checks the cached map first (the
 * common case, since a tenant's deals mostly cycle through the SAME
 * small set of pipeline stages); only hits the live API when a
 * genuinely unseen stage_id shows up, then persists the refreshed full
 * map so future lookups for that stage are free.
 */
async function resolveStageName(tenant: Tenant, stageId: number): Promise<string | null> {
  let map: Record<string, string> = {};
  try {
    map = tenant.stageNameMap ? JSON.parse(tenant.stageNameMap) : {};
  } catch {
    map = {};
  }
  if (map[String(stageId)]) return map[String(stageId)];
  if (!tenant.pipedriveApiToken) return null;
  try {
    const stages = await listStages(tenant.pipedriveApiToken);
    const freshMap: Record<string, string> = {};
    for (const s of stages) freshMap[String(s.id)] = s.name;
    await db.tenant.updateStageNameMap(tenant.id, JSON.stringify(freshMap));
    // Keep the in-memory tenant object consistent for the rest of THIS
    // request too, in case another stage_id needs resolving later in
    // the same webhook handler run.
    tenant.stageNameMap = JSON.stringify(freshMap);
    return freshMap[String(stageId)] ?? null;
  } catch (err) {
    console.error(`[webhooks] resolveStageName failed to fetch stages for tenant ${tenant.id}:`, err);
    return null;
  }
}

/**
 * All touchpoints of one channel for an identity, most-recent first — the
 * shared building block for "has this specific Pipedrive event already
 * been logged" checks below (deal stage dedup, activity-completion
 * dedup). Deliberately scans this identity's full history rather than
 * keeping separate "last known state" columns: touchpoint volume per
 * identity is small (tens, not thousands) in this app's actual usage, and
 * reusing the existing touchpoints table avoids a second source of truth
 * that could drift out of sync with it.
 */
async function touchpointsOfChannel(tenantId: string, identityId: string, channel: string) {
  const touchpoints = await db.touchpoint.findMany({
    where: { tenantId, identityId },
    orderBy: { occurredAt: "desc" },
  });
  return touchpoints.filter((tp) => tp.channel === channel);
}

function parseMetadata(tp: { metadata: string | null }): any {
  if (!tp.metadata) return null;
  try {
    return JSON.parse(tp.metadata);
  } catch {
    return null;
  }
}

/**
 * When a completed Activity touchpoint "actually happened," for timeline
 * ordering purposes. Prefers `marked_as_done_time` (Pipedrive's own record
 * of when it was checked off) and falls back to `update_time` (still a
 * real modification timestamp, close enough). Deliberately does NOT fall
 * back to `due_date`/`due_time` — a due date is when the activity was
 * *scheduled* for, which can be an arbitrary date, or default to midnight
 * when no specific due time was set. Using it as a stand-in for "when
 * this happened" produced a real bug: a completed activity showing up
 * hours before touchpoints that genuinely happened first, wrongly
 * flagged as "First touch." Webhook receipt time is a safer fallback.
 */
function resolveActivityOccurredAt(data: any): Date {
  if (data.marked_as_done_time) {
    const d = new Date(data.marked_as_done_time);
    if (!isNaN(d.getTime())) return d;
  }
  if (data.update_time) {
    const d = new Date(data.update_time);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

webhooksRouter.post("/webhooks/pipedrive", requireTenant, requireTenantSecret("secret", "webhookSecret"), async (req, res) => {
  try {
    const tenant = req.tenant!;
    const body = req.body || {};
    const entity = body?.meta?.entity || body?.event?.split(".")?.[0];
    const action = body?.meta?.action || body?.event?.split(".")?.[1];
    const data = body.data || {};

    if (entity === "person") {
      const email = extractPersonEmail(data);
      // Same "allowed to be null, mergeIdentities treats null as leave
      // it alone" reasoning as email — a person.change that only edited,
      // say, an org field arrives with no name/phone in the diff either.
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : null;
      const phone = extractPersonPhone(data);
      if (data.id) {
        // email is intentionally allowed to be null here (see
        // extractPersonEmail's doc comment) — mergeIdentities already
        // treats a null email as "don't match/set by email this time,"
        // and we still want every person event (not just ones that
        // happen to touch the email field) to re-sync in case new
        // touchpoints landed on this identity since the last sync.
        const identity = await mergeIdentities(tenant, { email, name, phone, pipedrivePersonId: data.id });
        // See captureSegmentValue's doc comment — Johari's own segment
        // field (Label) turned out to live on the Person record, not
        // Deal/Lead, so this handler needs the same capture call the
        // deal/lead handlers already have.
        await captureSegmentValue(tenant, identity, data, "person");
        // Backfill: this Person may already have anonymous touchpoints
        // (ad click, blog visits) recorded before Pipedrive knew who they
        // were. Push the summary now rather than waiting for the next
        // touchpoint, which might be a while (or never).
        await syncPersonAttribution(tenant, identity);
      }
      return res.json({ ok: true });
    }

    if (entity === "deal") {
      const personId = data.person_id?.value || data.person_id;
      if (personId) {
        // Resolve/merge the identity FIRST, through mergeIdentities'
        // multi-candidate consolidation (matches by email OR anonymousId
        // OR pipedrivePersonId, and folds duplicates into one) — instead
        // of recordTouchpoint's own resolveIdentity(), which only knows
        // this call's pipedrivePersonId and would happily create a brand
        // new, disconnected identity if this deal event happens to be
        // processed before a Person event has linked pipedrivePersonId
        // onto the identity that's already tracking this person by email
        // or anonymous cookie. That's a real race, not a hypothetical
        // one: Pipedrive can fire person.create and deal.create for the
        // same brand-new contact within the same second, and whichever
        // webhook we process first "wins" the identity unless both paths
        // use the same strength of matching.
        const identity0 = await mergeIdentities(tenant, {
          pipedrivePersonId: personId,
          pipedriveDealId: data.id ?? undefined,
        });
        const identity = await backfillContactFromPipedrive(tenant, identity0, personId);
        await captureSegmentValue(tenant, identity, data, "deal");

        // Only log a touchpoint when the stage genuinely changed — Pipedrive
        // fires a "deal updated" webhook for ANY field edit, including the
        // custom-fields writes this app itself makes (syncPersonAttribution
        // / freezeDealAttribution PATCHing the deal). Without this check,
        // every one of those echoes back in as a bogus "moved to stage X"
        // entry, even though the stage never moved — that's what produced
        // the run of near-identical duplicate entries seen in testing.
        // `data.stage_id === undefined` (as opposed to present-but-same)
        // means this particular webhook payload didn't even touch the
        // stage field — Pipedrive's "updated" events are partial diffs, so
        // that's the normal case for e.g. a value or note edit, not a
        // signal to treat the stage as having changed to "unknown."
        if (data.id && data.stage_id !== undefined) {
          const priorStageChanges = await touchpointsOfChannel(tenant.id, identity.id, "pipedrive_stage_change");
          const lastForThisDeal = priorStageChanges.find((tp) => parseMetadata(tp)?.dealId === data.id);
          const lastStageId = lastForThisDeal ? parseMetadata(lastForThisDeal)?.stageId ?? null : null;

          if (data.stage_id !== lastStageId) {
            const verb = lastForThisDeal ? "moved to" : "entered";
            await db.touchpoint.create({
              data: {
                tenantId: tenant.id,
                identityId: identity.id,
                channel: "pipedrive_stage_change",
                source: "pipedrive",
                title: `Deal "${data.title}" ${verb} stage ${data.stage_id}`,
                metadata: JSON.stringify({ dealId: data.id, stageId: data.stage_id, status: data.status }),
                occurredAt: new Date(),
              },
            });
            const stageName = await resolveStageName(tenant, data.stage_id);
            if (stageName) {
              await db.identity.setDealCurrentStage({
                where: { tenantId: tenant.id, id: identity.id },
                dealCurrentStageId: data.stage_id,
                dealCurrentStageName: stageName,
              });
            }
            void syncPersonAttribution(tenant, identity).catch((err) =>
              console.error(`[webhooks] syncPersonAttribution after deal touchpoint failed for tenant ${tenant.id}:`, err)
            );
          }
        }

        // On creation specifically, freeze a first-touch/last-touch
        // snapshot onto the deal's own custom fields (see
        // lib/attribution.ts and lib/pipedrive-fields.ts) — "what caused
        // THIS deal", separate from the Person's living, ever-updating
        // journey. Pipedrive's webhook action naming has varied across
        // API versions ("added" in v1, "create" in newer subscriptions),
        // so we check both.
        if (data.id && ["added", "create", "created"].includes(String(action))) {
          const createdAt = data.add_time ? new Date(data.add_time) : new Date();
          // Applied BEFORE the freeze below, so if this creates a
          // fallback touchpoint (only happens when the identity has
          // zero touchpoints so far), that touchpoint becomes what gets
          // frozen as this Deal's first-touch source — not left stuck
          // showing the next real event (often just a generic
          // "pipedrive_stage_change") as if THAT were the origin.
          await applyLeadSourceFallback(tenant, identity, data, createdAt);
          await freezeDealAttribution(tenant, { dealId: data.id, pipedrivePersonId: personId, dealCreatedAt: createdAt });

          // Same freeze, mirrored into our own DB (not just Pipedrive's
          // custom fields) so the dashboard's Recently active prospects
          // list can show "how much activity before this became a Deal"
          // without an extra Pipedrive round trip — see
          // lib/portal-summary.ts. Guarded on dealCreatedDealId so a
          // duplicate delivery of the same creation event doesn't
          // recompute (and potentially shift) an already-frozen count.
          if (identity.dealCreatedDealId !== data.id) {
            const touchpoints = await db.touchpoint.findMany({
              where: { tenantId: tenant.id, identityId: identity.id },
              orderBy: { occurredAt: "asc" },
            });
            const leadToDealTouchpoints = countTouchpointsUpTo(touchpoints, createdAt);
            await db.identity.setDealMilestone({
              where: { tenantId: tenant.id, id: identity.id },
              data: {
                dealCreatedDealId: data.id,
                dealCreatedAt: createdAt,
                leadToDealTouchpoints,
                // Best-effort, same partial-diff caveat as the Won
                // handler's own value capture — no live-fetch fallback.
                dealValueAtCreate: typeof data.value === "number" ? data.value : undefined,
                dealCurrencyAtCreate: typeof data.currency === "string" ? data.currency : undefined,
              },
            });
            await syncDealMilestoneField(tenant, data.id, "deal_lead_to_deal_touchpoints", leadToDealTouchpoints);
          }
        }

        // Deal marked Won — the second milestone, "how much activity
        // between Deal creation and Won." Pipedrive webhook payloads are
        // partial diffs (see extractPersonEmail's doc comment above), so
        // `data.status` is only present here when the status field
        // itself just changed — this fires right at the moment a deal
        // flips to won, not on every later edit to an already-won deal.
        // wonDealId still guards against a duplicate delivery of that
        // same transition being double-counted.
        if (data.id && data.status === "won" && identity.wonDealId !== data.id) {
          let dealCreatedAt =
            identity.dealCreatedDealId === data.id && identity.dealCreatedAt ? identity.dealCreatedAt : null;

          if (!dealCreatedAt && tenant.pipedriveApiToken) {
            // This deal's creation was never captured above — either it
            // predates this feature, or its "created" webhook was missed.
            // Fetch its actual creation time live rather than silently
            // skipping the milestone.
            try {
              const deal: any = await getDeal(tenant.pipedriveApiToken, data.id);
              if (deal?.add_time) dealCreatedAt = new Date(deal.add_time);
            } catch (err) {
              console.error(`[webhooks] couldn't fetch Deal ${data.id} to resolve its creation time:`, err);
            }
          }

          if (dealCreatedAt) {
            const wonAt = data.won_time ? new Date(data.won_time) : new Date();
            const touchpoints = await db.touchpoint.findMany({
              where: { tenantId: tenant.id, identityId: identity.id },
              orderBy: { occurredAt: "asc" },
            });
            const dealToWonTouchpoints = countTouchpointsBetween(touchpoints, dealCreatedAt, wonAt);
            // value/currency are read straight off this webhook's own
            // payload, best-effort — unlike dealCreatedAt above, there's
            // no live-fetch fallback if a particular "won" webhook
            // happens to omit them (Pipedrive's partial-diff behavior,
            // see extractPersonEmail's doc comment), so an occasional
            // Won deal might end up with no captured value. Acceptable
            // for now; a live getDeal() fallback (mirroring
            // dealCreatedAt's own fallback a few lines up) would close
            // that gap if it turns out to matter in practice.
            await db.identity.setDealMilestone({
              where: { tenantId: tenant.id, id: identity.id },
              data: {
                wonDealId: data.id,
                dealToWonTouchpoints,
                dealWonAt: wonAt,
                dealValue: typeof data.value === "number" ? data.value : undefined,
                dealCurrency: typeof data.currency === "string" ? data.currency : undefined,
              },
            });
            await syncDealMilestoneField(tenant, data.id, "deal_deal_to_won_touchpoints", dealToWonTouchpoints);
          }
        }
      }
      return res.json({ ok: true });
    }

    // LEAD — the pre-Deal-conversion object. Deliberately unverified
    // against a live account (same caution as setup-pipedrive-fields.ts
    // and updateLeadCustomFields): the exact webhook payload shape for
    // Lead events, and even the field name Pipedrive expects for "Event
    // objects" in its webhook UI, came from documentation rather than a
    // confirmed live test.
    //
    // Captures a PERMANENT source snapshot the first time we ever see
    // this identity's Lead — guarded purely by identity.leadCreatedAt
    // already being set, deliberately NOT by inspecting the webhook's
    // action name ("added"/"create"/"updated"/etc, the way the Deal
    // handler below does): since we're not confident exactly which
    // action strings Pipedrive sends for Leads, checking "has this
    // identity ever been frozen before" is a simpler, more robust guard
    // that doesn't depend on getting that naming right. The practical
    // effect: whichever Lead webhook event (create OR change) happens to
    // arrive FIRST for a given identity is the one that freezes the
    // source — normally that's the genuine creation event anyway, since
    // it's almost always first. A later "change" event for the same
    // already-frozen identity is a no-op here by design (see
    // freezeLeadAttribution's doc comment for why it must stay
    // permanent), but the identity<->Lead link itself (pipedriveLeadIds,
    // via mergeIdentities) still gets recorded every time regardless.
    if (entity === "lead") {
      const personId = data.person_id?.value || data.person_id;
      if (personId && data.id) {
        const identity0 = await mergeIdentities(tenant, {
          pipedrivePersonId: personId,
          pipedriveLeadId: String(data.id),
        });
        const identity = await backfillContactFromPipedrive(tenant, identity0, personId);
        await captureSegmentValue(tenant, identity, data, "deal");
        if (!identity.leadCreatedAt) {
          const leadCreatedAt = data.add_time ? new Date(data.add_time) : new Date();
          await applyLeadSourceFallback(tenant, identity, data, leadCreatedAt);
          await db.identity.setLeadMilestone({
            where: { tenantId: tenant.id, id: identity.id },
            data: { leadCreatedAt, leadCreatedLeadId: String(data.id) },
          });
          await freezeLeadAttribution(tenant, { leadId: String(data.id), pipedrivePersonId: personId, leadCreatedAt });
        }
      }
      return res.json({ ok: true });
    }

    if (entity === "activity") {
      const personId = data.person_id;
      // Only completed activities — a scheduled-but-not-yet-done call or
      // meeting isn't a real touchpoint yet (see the dashboard's Pipedrive
      // setup card, which now asks for this webhook specifically to
      // surface completed sales activities in a prospect's timeline).
      if (personId && data.id && data.done) {
        // Same race-avoidance as the deal handler above.
        const identity0 = await mergeIdentities(tenant, { pipedrivePersonId: personId });
        const identity = await backfillContactFromPipedrive(tenant, identity0, personId);

        // Dedup by activityId — once logged, a later edit to an
        // already-completed activity (updating its notes, say) shouldn't
        // create a second timeline entry for the same completion.
        const alreadyLogged = (await touchpointsOfChannel(tenant.id, identity.id, "pipedrive_activity")).some(
          (tp) => parseMetadata(tp)?.activityId === data.id
        );

        if (!alreadyLogged) {
          await db.touchpoint.create({
            data: {
              tenantId: tenant.id,
              identityId: identity.id,
              channel: "pipedrive_activity",
              // Pipedrive's own activity type (call, meeting, task, or a
              // custom type like "whatsapp_chat") — a genuinely useful
              // attribution signal on its own, so it belongs in the
              // structured `source` field, filterable/reportable like
              // any website source, not just buried inside the free-text
              // title below. Falls back to "pipedrive" only if Pipedrive
              // somehow sends an activity with no type at all (activity
              // type is normally a required field when one's created).
              source: data.type || "pipedrive",
              title: `${data.type || "Activity"} completed: ${data.subject || ""}`.trim(),
              metadata: JSON.stringify({ activityId: data.id, done: data.done }),
              occurredAt: resolveActivityOccurredAt(data),
            },
          });
          void syncPersonAttribution(tenant, identity).catch((err) =>
            console.error(`[webhooks] syncPersonAttribution after activity touchpoint failed for tenant ${tenant.id}:`, err)
          );
        }
      }
      return res.json({ ok: true });
    }

    if (entity === "note") {
      const personId = data.person_id;
      if (personId) {
        // Same race-avoidance as the deal handler above.
        const identity0 = await mergeIdentities(tenant, { pipedrivePersonId: personId });
        const identity = await backfillContactFromPipedrive(tenant, identity0, personId);
        await db.touchpoint.create({
          data: {
            tenantId: tenant.id,
            identityId: identity.id,
            channel: "pipedrive_note",
            source: "pipedrive",
            title: "Note added",
            metadata: JSON.stringify({ noteId: data.id }),
            occurredAt: new Date(),
          },
        });
      }
      return res.json({ ok: true });
    }

    // Unhandled entity types are just acknowledged so Pipedrive doesn't retry.
    res.json({ ok: true, ignored: entity ?? action ?? "unknown" });
  } catch (err: any) {
    console.error("[/webhooks/pipedrive]", err);
    res.status(500).json({ error: err.message });
  }
});
