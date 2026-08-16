import crypto from "crypto";
import { Tenant } from "../db";

/**
 * Signs/verifies the "View full journey" link embedded in the "AS: View
 * Journey" Pipedrive custom field (see pipedrive-fields.ts and
 * pipedrive-sync.ts) — an interim stand-in for a real Pipedrive Custom UI
 * Extension (an actual in-app popup), which is a separate, much bigger
 * project (a registered Pipedrive App, OAuth, hosting requirements,
 * likely a review). This is deliberately a click-through link with no
 * login required: a rep clicking the field from inside Pipedrive isn't
 * necessarily logged into the separate self-serve portal, and gating on
 * that login would defeat the point.
 *
 * Reuses the tenant's own `webhookSecret` as the HMAC key rather than
 * introducing a second secret to generate/store/rotate — it's already a
 * private, per-tenant value that never reaches the browser. The token is
 * scoped to exactly one identity (can't be reused to view a different
 * prospect) but is a long-lived bearer credential: anyone who gets hold
 * of this exact URL can view that one prospect's journey without
 * logging in. Rotating a tenant's webhookSecret (not currently exposed
 * as an action anywhere) would invalidate every journey link issued
 * under the old one, same as it would every webhook URL.
 */
export function signJourneyToken(tenant: Tenant, identityId: string): string {
  return crypto.createHmac("sha256", tenant.webhookSecret).update(`journey:${identityId}`).digest("hex").slice(0, 32);
}

/**
 * Constant-time compare — this token is a bearer credential, so a naive
 * `===` would leak timing information about how many leading characters
 * of a guess were correct.
 */
export function verifyJourneyToken(tenant: Tenant, identityId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  const expected = signJourneyToken(tenant, identityId);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The server's own public base URL, for building a link that works when
 * clicked from inside Pipedrive (i.e. outside any request context this
 * app is currently handling) — unlike routes/portal.ts's publicBaseUrl,
 * which can fall back to the incoming request's own protocol/host, this
 * is called from library code with no `req` available (webhook handling,
 * touchpoint recording), so PUBLIC_BASE_URL must be set explicitly. See
 * .env.example.
 */
function publicBaseUrlFromEnv(): string | null {
  const configured = process.env.PUBLIC_BASE_URL;
  return configured ? configured.replace(/\/+$/, "") : null;
}

/**
 * Builds the full "View full journey" URL for one identity, or null if
 * PUBLIC_BASE_URL isn't configured — callers should treat null as "skip
 * setting this field this time" (same best-effort philosophy as the rest
 * of pipedrive-sync.ts) rather than throw, since every other field in a
 * sync should still go through.
 */
export function journeyLinkUrl(tenant: Tenant, identityId: string): string | null {
  const base = publicBaseUrlFromEnv();
  if (!base) return null;
  const token = signJourneyToken(tenant, identityId);
  return `${base}/attribution/journey/${identityId}?tenant=${encodeURIComponent(tenant.id)}&token=${token}`;
}
