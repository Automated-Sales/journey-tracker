import { Router } from "express";
import { db } from "../db";
import { recordTouchpoint } from "../lib/identity";
import { logWebsiteVisit } from "../lib/pipedrive-sync";
import { requireTenant, requireTenantSecret } from "./tenant-middleware";
import { Channel } from "../lib/types";

// A tab left open overnight shouldn't record a multi-hour "time on page" —
// cap at 2 hours, generous for any real reading/browsing session but
// enough to keep this useless as a lead-scoring signal if left unclamped.
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;

export const trackRouter = Router({ mergeParams: true });

/**
 * Last-resort source of channel/source when a visit carries neither a
 * utm_source nor an ad click ID — the common case for an UNTAGGED link
 * (someone posts a link on LinkedIn/Instagram/etc without adding UTM
 * params, or a visitor searches on Google and clicks the organic
 * result). Matched against document.referrer's hostname, which is why
 * this only ever fires on the FIRST touchpoint of a visit — every later
 * pageview in the same session has the visitor's own site as its
 * referrer, which matches nothing here and correctly falls through to
 * plain "website".
 *
 * Known limitation, worth knowing about rather than silently trusting:
 * several mobile in-app browsers (Facebook, Instagram, TikTok in
 * particular) strip or omit the Referer header entirely for privacy
 * reasons, so a real organic-social click can still land here with
 * referrer = null and get bucketed as generic "website" traffic. UTM
 * tagging the actual post/bio link is the only fully reliable fix for
 * that — referrer sniffing is a best-effort fallback for untagged
 * links, not a replacement for tagging.
 */
const SOCIAL_REFERRER_PATTERNS: Array<[RegExp, string]> = [
  [/(^|\.)facebook\.com$/, "facebook"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)lnkd\.in$/, "linkedin"],
  [/(^|\.)twitter\.com$/, "twitter"],
  [/(^|\.)x\.com$/, "twitter"],
  [/(^|\.)t\.co$/, "twitter"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)youtube\.com$/, "youtube"],
  [/(^|\.)youtu\.be$/, "youtube"],
  [/(^|\.)pinterest\.[a-z.]+$/, "pinterest"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/(^|\.)threads\.net$/, "threads"],
  [/(^|\.)snapchat\.com$/, "snapchat"],
  [/(^|\.)quora\.com$/, "quora"],
];

const SEARCH_REFERRER_PATTERNS: Array<[RegExp, string]> = [
  [/(^|\.)google\.[a-z.]+$/, "google"],
  [/(^|\.)bing\.com$/, "bing"],
  [/(^|\.)duckduckgo\.com$/, "duckduckgo"],
  [/(^|\.)yahoo\.com$/, "yahoo"],
];

function inferFromReferrer(referrer: string | null): { channel: Channel; source: string; medium: string } | null {
  if (!referrer) return null;
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  for (const [pattern, name] of SOCIAL_REFERRER_PATTERNS) {
    if (pattern.test(host)) return { channel: "social_organic", source: name, medium: "social" };
  }
  for (const [pattern, name] of SEARCH_REFERRER_PATTERNS) {
    if (pattern.test(host)) return { channel: "website_visit", source: name, medium: "organic" };
  }
  return null;
}

/**
 * Called by the website tracking snippet (server/public/automated-sales-tracker.js)
 * on every pageview. Mounted at /t/:tenant/api/track.
 * Body: { anonymousId, url, title, referrer, utm: {...}, clickIds: {...} }
 */
trackRouter.post("/track", requireTenant, requireTenantSecret("key", "trackKey"), async (req, res) => {
  try {
    const { anonymousId, url, title, referrer, utm = {}, clickIds = {} } = req.body || {};
    if (!anonymousId || !url) {
      return res.status(400).json({ error: "anonymousId and url are required" });
    }

    // clickId stays the single "was this an ad click at all" signal used
    // for channel/source below (unchanged, for backwards compatibility);
    // gclid/fbclid/msclkid are kept separately too so a URL carrying more
    // than one (rare, but possible with multi-platform retargeting pixels
    // stacked on one link) doesn't silently lose the others the way a
    // single merged field would.
    const clickId = clickIds.gclid || clickIds.li_fat_id || clickIds.msclkid || clickIds.fbclid || null;

    // Only fall back to referrer-sniffing when there's genuinely no UTM
    // tag and no ad click ID — an untagged link is the one case where the
    // referring domain is the only attribution signal available at all.
    const inferred = !utm.utm_source && !clickId ? inferFromReferrer(referrer || null) : null;

    const channel = clickId ? "ad_click" : inferred ? inferred.channel : "website_visit";
    const source =
      utm.utm_source ||
      (clickId
        ? clickIds.li_fat_id
          ? "linkedin_ads"
          : clickIds.gclid
            ? "google_ads"
            : clickIds.fbclid
              ? "facebook_ads"
              : "bing_ads"
        : inferred
          ? inferred.source
          : "website");
    const medium = utm.utm_medium || (inferred ? inferred.medium : null);

    const { identity, touchpoint } = await recordTouchpoint(req.tenant!, {
      channel,
      source,
      campaign: utm.utm_campaign || null,
      medium,
      content: utm.utm_content || null,
      term: utm.utm_term || null,
      clickId,
      gclid: clickIds.gclid || null,
      fbclid: clickIds.fbclid || null,
      msclkid: clickIds.msclkid || null,
      liFatId: clickIds.li_fat_id || null,
      referrer: referrer || null,
      url,
      title: title || null,
      anonymousId,
      occurredAt: new Date(),
    });

    res.json({ ok: true, identityId: identity.id, touchpointId: touchpoint.id });
  } catch (err: any) {
    console.error("[/api/track]", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Reports how long a visitor stayed on the page a touchpoint was created
 * for — sent by the snippet when they navigate away (tab hidden / page
 * unload) or, on a client-side-routed SPA, right before the *next*
 * touchpoint is recorded. A touchpoint's duration is never known at the
 * moment it's created, so this always arrives as a follow-up call, not
 * as part of /track. Best-effort by design (see automated-sales-tracker.js):
 * a failed or missing duration update just means that one touchpoint has
 * no duration recorded, never a broken pageview record. Mounted at
 * /t/:tenant/api/track/duration.
 * Body: { touchpointId, durationMs }
 */
trackRouter.post("/track/duration", requireTenant, requireTenantSecret("key", "trackKey"), async (req, res) => {
  const { touchpointId, durationMs } = req.body || {};
  if (!touchpointId || typeof durationMs !== "number" || !isFinite(durationMs)) {
    return res.status(400).json({ error: "touchpointId and a numeric durationMs are required" });
  }
  const clamped = Math.max(0, Math.min(Math.round(durationMs), MAX_DURATION_MS));

  let touchpoint;
  try {
    touchpoint = await db.touchpoint.updateDuration({ id: touchpointId, tenantId: req.tenant!.id, durationMs: clamped });
  } catch (err: any) {
    console.error("[/api/track/duration]", err);
    return res.status(500).json({ error: err.message });
  }

  res.json({ ok: true });

  // Fire-and-forget, after the response is already sent — a visitor's
  // browser shouldn't wait on a Pipedrive round trip for something this
  // invisible to them, and any failure here must never surface as an
  // HTTP error since headers are already gone. See lib/pipedrive-sync.ts
  // logWebsiteVisit for the actual per-tenant on/off/notes/activities
  // decision — this just supplies the now-complete touchpoint + identity.
  const tenant = req.tenant!;
  if (touchpoint?.identityId) {
    db.identity
      .findUnique({ where: { tenantId: tenant.id, id: touchpoint.identityId } })
      .then((identity) => (identity ? logWebsiteVisit(tenant, identity, touchpoint!) : undefined))
      .catch((err) => console.error(`[track] logWebsiteVisit failed for tenant ${tenant.id}:`, err));
  }
});
