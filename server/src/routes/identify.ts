import { Router } from "express";
import { mergeIdentities, recordTouchpoint } from "../lib/identity";
import { findPersonByEmail } from "../lib/pipedrive";
import { requireTenant, requireTenantSecret } from "./tenant-middleware";

export const identifyRouter = Router({ mergeParams: true });

/**
 * Called the moment an anonymous visitor becomes known — e.g. on form
 * submit ("book a call", "request a demo"), or from a Pipedrive Person
 * creation webhook. This is what stitches the pre-conversion journey
 * (ad click -> blog read -> pricing page) onto the record a sales rep
 * actually sees in Pipedrive. Mounted at /t/:tenant/api/identify.
 *
 * Body: { email, anonymousId? }
 */
identifyRouter.post("/identify", requireTenant, requireTenantSecret("key", "trackKey"), async (req, res) => {
  try {
    const tenant = req.tenant!;
    const { email, anonymousId, url } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required" });

    let pipedrivePersonId: number | null = null;
    if (tenant.pipedriveApiToken) {
      try {
        const match = await findPersonByEmail(tenant.pipedriveApiToken, email);
        pipedrivePersonId = match?.id ?? null;
      } catch {
        // Pipedrive lookup is best-effort — if the token isn't configured yet
        // we still want identify() to succeed.
      }
    }

    const identity = await mergeIdentities(tenant, { email, anonymousId, pipedrivePersonId });

    if (email) {
      await recordTouchpoint(tenant, {
        channel: "website_visit",
        source: "website",
        title: "Identified (form submit / signup)",
        // The page the form itself was on ("Submitted from") — distinct
        // from the landing page (first touchpoint's url), which is where
        // the visit as a whole started, not necessarily where they
        // converted. Previously this touchpoint recorded no url at all,
        // so "which page had the form" had to be inferred from whichever
        // website_visit touchpoint happened to be nearby in time.
        url: url || null,
        email,
        anonymousId,
        occurredAt: new Date(),
      });
    }

    res.json({ ok: true, identityId: identity.id, pipedrivePersonId: identity.pipedrivePersonId });
  } catch (err: any) {
    console.error("[/api/identify]", err);
    res.status(500).json({ error: err.message });
  }
});
