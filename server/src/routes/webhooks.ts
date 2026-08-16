import { Router } from "express";
import { db } from "../db";
import { recordTouchpoint, mergeIdentities } from "../lib/identity";
import { freezeDealAttribution, syncPersonAttribution, syncDealMilestoneField } from "../lib/pipedrive-sync";
import { requireTenant, requireTenantSecret } from "./tenant-middleware";
import { getDeal } from "../lib/pipedrive";
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
      if (data.id) {
        // email is intentionally allowed to be null here (see
        // extractPersonEmail's doc comment) — mergeIdentities already
        // treats a null email as "don't match/set by email this time,"
        // and we still want every person event (not just ones that
        // happen to touch the email field) to re-sync in case new
        // touchpoints landed on this identity since the last sync.
        const identity = await mergeIdentities(tenant, { email, pipedrivePersonId: data.id });
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
        const identity = await mergeIdentities(tenant, {
          pipedrivePersonId: personId,
          pipedriveDealId: data.id ?? undefined,
        });

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
              data: { dealCreatedDealId: data.id, dealCreatedAt: createdAt, leadToDealTouchpoints },
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
            await db.identity.setDealMilestone({
              where: { tenantId: tenant.id, id: identity.id },
              data: { wonDealId: data.id, dealToWonTouchpoints },
            });
            await syncDealMilestoneField(tenant, data.id, "deal_deal_to_won_touchpoints", dealToWonTouchpoints);
          }
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
        const identity = await mergeIdentities(tenant, { pipedrivePersonId: personId });

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
              source: "pipedrive",
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
        const identity = await mergeIdentities(tenant, { pipedrivePersonId: personId });
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
