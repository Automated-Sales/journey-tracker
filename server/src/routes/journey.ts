import { Router } from "express";
import { db, Identity, Tenant } from "../db";
import { getDeal } from "../lib/pipedrive";
import { requireTenant } from "./tenant-middleware";

export const journeyRouter = Router({ mergeParams: true });

async function journeyForIdentity(tenant: Tenant, identity: Identity) {
  const touchpoints = await db.touchpoint.findMany({
    where: { tenantId: tenant.id, identityId: identity.id },
    orderBy: { occurredAt: "asc" },
  });

  return {
    identity: {
      id: identity.id,
      email: identity.email,
      pipedrivePersonId: identity.pipedrivePersonId,
      firstSeenAt: identity.firstSeenAt,
      lastSeenAt: identity.lastSeenAt,
    },
    touchpoints: touchpoints.map((t) => ({
      ...t,
      metadata: t.metadata ? JSON.parse(t.metadata) : null,
    })),
  };
}

/**
 * The core read endpoint: the Pipedrive panel calls this with the
 * Person ID Pipedrive gives it, and gets back the full cross-channel
 * timeline for that prospect, oldest first. Mounted at
 * /t/:tenant/api/journey/by-person/:personId.
 *
 * Note: unlike /api/track and /api/identify, this isn't gated by the
 * tenant's trackKey — the panel iframe URL doesn't have a clean place to
 * carry a secret today. Fine for a private-app-per-client rollout where
 * the tenant slug itself isn't public; revisit if that changes.
 */
journeyRouter.get("/journey/by-person/:personId", requireTenant, async (req, res) => {
  try {
    const tenant = req.tenant!;
    const personId = Number(req.params.personId);
    const identity = await db.identity.findUnique({ where: { tenantId: tenant.id, pipedrivePersonId: personId } });
    if (!identity) return res.json({ identity: null, touchpoints: [] });
    res.json(await journeyForIdentity(tenant, identity));
  } catch (err: any) {
    console.error("[/api/journey/by-person]", err);
    res.status(500).json({ error: err.message });
  }
});

journeyRouter.get("/journey/by-email/:email", requireTenant, async (req, res) => {
  try {
    const tenant = req.tenant!;
    const email = req.params.email.toLowerCase();
    const identity = await db.identity.findUnique({ where: { tenantId: tenant.id, email } });
    if (!identity) return res.json({ identity: null, touchpoints: [] });
    res.json(await journeyForIdentity(tenant, identity));
  } catch (err: any) {
    console.error("[/api/journey/by-email]", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Used by the panel when it's rendered on a Deal detail view: Pipedrive
 * only gives the extension the Deal ID via URL params, not the linked
 * Person ID, so we look the deal up via the Pipedrive API to find its
 * person_id, then return the same shape as /journey/by-person.
 */
journeyRouter.get("/journey/by-deal/:dealId", requireTenant, async (req, res) => {
  try {
    const tenant = req.tenant!;
    if (!tenant.pipedriveApiToken) {
      return res.status(400).json({ error: `Tenant "${tenant.id}" has no Pipedrive API token configured` });
    }
    const dealId = Number(req.params.dealId);
    const deal = await getDeal(tenant.pipedriveApiToken, dealId);
    const personId = deal?.person_id?.value ?? deal?.person_id ?? null;
    if (!personId) {
      return res.json({ identity: null, touchpoints: [], note: "Deal has no linked person" });
    }

    const identity = await db.identity.findUnique({
      where: { tenantId: tenant.id, pipedrivePersonId: Number(personId) },
    });
    if (!identity) return res.json({ identity: null, touchpoints: [] });
    res.json(await journeyForIdentity(tenant, identity));
  } catch (err: any) {
    console.error("[/api/journey/by-deal]", err);
    res.status(500).json({ error: err.message });
  }
});
