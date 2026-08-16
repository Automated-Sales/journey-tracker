import { Router, Request, Response, NextFunction } from "express";
import { db, Tenant, Touchpoint } from "../db";
import { getMe, deepLinkForPerson } from "../lib/pipedrive";
import { setupPipedriveFields } from "../lib/pipedrive-field-setup";
import { validateSignupForm, provisionSelfServeTenant } from "../lib/portal-signup";
import { buildPortalSummary } from "../lib/portal-summary";
import { buildProspectsCsv, buildCampaignsCsv } from "../lib/csv";
import { verifyJourneyToken } from "../lib/journey-link";
import { createCheckoutSession, createBillingPortalSession, stripeConfigured, isBillingActive } from "../lib/stripe";
import {
  verifyPassword,
  getSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  SESSION_TTL_MS,
} from "../lib/auth";

// Public-facing routes for the self-serve portal (marketing
// page + signup + login + the aggregated client dashboard). Deliberately
// NOT mounted under /t/:tenant — a visitor doesn't know their tenant slug
// yet at signup time, and after login the session cookie (not a URL
// param) is what identifies which tenant they're looking at. See
// tenant-middleware.ts for the separate, API-key-based scoping used by
// the tracking snippet / webhooks / panel, which is a different trust
// model (a machine holding a secret key) from this one (a human with a
// password).
export const portalRouter = Router();

declare global {
  namespace Express {
    interface Request {
      portalTenant?: Tenant;
    }
  }
}

/**
 * The base URL clients reach this server at, for building the exact
 * tracking snippet a tenant needs to paste in — see PUBLIC_BASE_URL in
 * .env.example. Falls back to the incoming request's own protocol/host
 * (reliable behind Caddy/nginx now that index.ts sets `trust proxy`),
 * so this works in local dev too without any env var.
 */
function publicBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

/**
 * Everything a client needs to wire up tracking, in the exact shape the
 * dashboard's "Install tracking" section renders — the three values the
 * WordPress plugin's settings page and the GTM Custom HTML tag both ask
 * for (see wordpress-plugin/ and gtm/custom-html-tag.html), plus a
 * ready-to-paste <head> snippet so someone who wants neither of those
 * can just paste two <script> tags once, site-wide.
 */
function buildInstallInfo(req: Request, tenant: Tenant) {
  const base = publicBaseUrl(req);
  const apiUrl = `${base}/t/${tenant.id}`;
  const scriptSrc = `${base}/automated-sales-tracker.js`;
  const trackKey = tenant.trackKey;
  const snippet = `<script>
  window.AS_TRACKER_API_URL = "${apiUrl}";
  window.AS_TRACKER_KEY = "${trackKey}";
</script>
<script src="${scriptSrc}"></script>`;
  return {
    apiUrl,
    scriptSrc,
    trackKey,
    snippet,
    wordpressPluginUrl: `${base}/downloads/automated-sales-tracker-wordpress-plugin.zip`,
    // Separate from tracking: this is what lets attribution actually land
    // back on a Person/Deal record once one exists in Pipedrive. Doesn't
    // create anything itself — see routes/webhooks.ts's doc comment and
    // the dashboard's "Sync back to Pipedrive" card.
    pipedriveWebhookUrl: `${apiUrl}/webhooks/pipedrive?secret=${tenant.webhookSecret}`,
  };
}

async function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = getSessionCookie(req);
  if (!token) return res.status(401).json({ error: "Not logged in" });
  const session = await db.session.findValid(token);
  if (!session) {
    clearSessionCookie(res);
    return res.status(401).json({ error: "Session expired — please log in again" });
  }
  const tenant = await db.tenant.findById(session.tenantId);
  if (!tenant) {
    clearSessionCookie(res);
    return res.status(401).json({ error: "Account no longer exists" });
  }
  req.portalTenant = tenant;
  next();
}

/**
 * Gates the dashboard's own data/export/settings routes on billing state
 * — the "block dashboard + API access" enforcement described in the
 * README's Billing section. Deliberately NOT applied to every
 * requireSession route: /api/me stays reachable so a gated dashboard can
 * still show *why* (trial ended, payment failed, etc.) and offer the
 * right button, /api/logout obviously needs to keep working, and the new
 * /api/billing/* routes below are how a gated tenant gets un-gated. Also
 * deliberately NOT applied to /api/journey/:identityId further down —
 * that route serves a Pipedrive rep who isn't the billing-paying user at
 * all, reached via a link already saved as plain text on a client's live
 * Pipedrive record (see lib/journey-link.ts); breaking already-issued
 * links over a billing lapse would strand data inside a customer's own
 * CRM, a harsher and more surprising failure mode than just blocking the
 * tenant's own dashboard.
 *
 * Also deliberately does NOT touch tracking ingestion (/t/:tenant/api/*,
 * webhooks) — those are a different router entirely (tenant-middleware.ts,
 * key/secret-authenticated) and out of scope here on purpose: pausing
 * *collection* during a billing hiccup would silently lose attribution
 * data for the gap, which is a worse outcome than just not letting the
 * lapsed tenant *view* it until they're current again.
 */
function requireActiveBilling(req: Request, res: Response, next: NextFunction) {
  const tenant = req.portalTenant!;
  if (isBillingActive(tenant.subscriptionStatus)) return next();
  res.status(402).json({
    error: "billing_required",
    subscriptionStatus: tenant.subscriptionStatus,
  });
}

/**
 * Validates the pasted Pipedrive token live (same call add-tenant's
 * operator would eyeball manually), creates the tenant, then best-effort
 * runs the exact same custom-field setup `npm run setup:pipedrive` does —
 * so a self-serve client doesn't need to know that CLI command exists.
 * Field setup failing does NOT fail the signup: tracking + the dashboard
 * both work without it, same as the CLI path (see pipedrive-sync.ts,
 * which already no-ops cleanly when personFieldMap isn't set yet).
 */
portalRouter.post("/api/signup", async (req, res) => {
  const form = req.body || {};
  const validationError = validateSignupForm(form);
  if (validationError) return res.status(400).json({ error: validationError });

  let me;
  try {
    me = await getMe(String(form.pipedriveToken).trim());
  } catch (err: any) {
    return res.status(400).json({
      error: "Couldn't verify that Pipedrive API token. Double-check it's correct and try again.",
      detail: err?.message,
    });
  }

  let tenant;
  try {
    tenant = await provisionSelfServeTenant({
      companyName: String(form.companyName),
      email: String(form.email),
      password: String(form.password),
      pipedriveToken: String(form.pipedriveToken),
      me,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || "Signup failed" });
  }

  try {
    await setupPipedriveFields(tenant.id, tenant.pipedriveApiToken!);
  } catch (err) {
    console.error(`[portal] field setup failed for new self-serve tenant ${tenant.id}:`, err);
    // Not fatal — see doc comment above.
  }

  const session = await db.session.create({ tenantId: tenant.id, ttlMs: SESSION_TTL_MS });
  setSessionCookie(res, session.token);

  // Straight into Stripe Checkout (14-day trial, no charge today) — the
  // new tenant is 'incomplete' until that finishes, and requireActiveBilling
  // will keep re-gating the dashboard until it does, so this is the
  // expected next step rather than optional. If Stripe isn't configured
  // on this server yet (local dev, or billing not set up), fall back to
  // going straight to the dashboard instead of failing the signup —
  // signup.html only redirects to checkoutUrl when one comes back.
  let checkoutUrl: string | null = null;
  if (stripeConfigured()) {
    try {
      const base = publicBaseUrl(req);
      checkoutUrl = await createCheckoutSession(tenant, {
        successUrl: `${base}/dashboard?billing=success`,
        cancelUrl: `${base}/dashboard?billing=cancelled`,
      });
    } catch (err) {
      console.error(`[portal] could not start checkout for new tenant ${tenant.id}:`, err);
      // Not fatal — the account exists; the dashboard's own billing gate
      // will offer a "Start free trial" retry button (see dashboard.html).
    }
  }

  res.status(201).json({ tenantId: tenant.id, name: tenant.name, checkoutUrl });
});

portalRouter.post("/api/login", async (req, res) => {
  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

  const tenant = await db.tenant.findBySignupEmail(email);
  if (!tenant || !verifyPassword(password, tenant.passwordHash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  const session = await db.session.create({ tenantId: tenant.id, ttlMs: SESSION_TTL_MS });
  setSessionCookie(res, session.token);
  res.json({ tenantId: tenant.id, name: tenant.name });
});

portalRouter.post("/api/logout", async (req, res) => {
  const token = getSessionCookie(req);
  if (token) await db.session.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

portalRouter.get("/api/me", requireSession, (req, res) => {
  const tenant = req.portalTenant!;
  res.json({
    tenantId: tenant.id,
    name: tenant.name,
    email: tenant.signupEmail,
    install: buildInstallInfo(req, tenant),
    pipedriveVisitLogging: tenant.pipedriveVisitLogging,
    // Deliberately NOT gated by requireActiveBilling (see that function's
    // doc comment) — the dashboard needs this to know WHY it's gated and
    // which button to show, which would be circular if this route itself
    // required active billing.
    billing: {
      status: tenant.subscriptionStatus,
      trialEndsAt: tenant.trialEndsAt ? tenant.trialEndsAt.toISOString() : null,
      currentPeriodEnd: tenant.currentPeriodEnd ? tenant.currentPeriodEnd.toISOString() : null,
    },
  });
});

/**
 * Starts (or resumes) Stripe Checkout for this tenant's subscription —
 * called right after signup, and again from the dashboard's billing-gate
 * banner for an 'incomplete' (abandoned checkout) or 'canceled' tenant.
 * Not billing-gated itself, for the obvious reason: this is how a gated
 * tenant gets ungated.
 */
portalRouter.post("/api/billing/checkout-session", requireSession, async (req, res) => {
  const tenant = req.portalTenant!;
  if (!stripeConfigured()) {
    return res.status(503).json({ error: "Billing isn't set up on this server yet — contact support." });
  }
  const base = publicBaseUrl(req);
  try {
    const url = await createCheckoutSession(tenant, {
      successUrl: `${base}/dashboard?billing=success`,
      cancelUrl: `${base}/dashboard?billing=cancelled`,
    });
    res.json({ url });
  } catch (err: any) {
    console.error(`[portal] checkout session failed for tenant ${tenant.id}:`, err);
    res.status(500).json({ error: err?.message || "Could not start checkout" });
  }
});

/**
 * Stripe's hosted "Manage billing" page — update card, view past
 * invoices, or cancel. Only works once a tenant has a real Stripe
 * customer (i.e. trialing/active/past_due, never 'incomplete' — see
 * lib/stripe.ts's createBillingPortalSession), so the dashboard should
 * only show this button in those states and route 'incomplete'/'canceled'
 * back to checkout-session above instead.
 */
portalRouter.post("/api/billing/portal-session", requireSession, async (req, res) => {
  const tenant = req.portalTenant!;
  if (!stripeConfigured()) {
    return res.status(503).json({ error: "Billing isn't set up on this server yet — contact support." });
  }
  const base = publicBaseUrl(req);
  try {
    const url = await createBillingPortalSession(tenant, `${base}/dashboard`);
    res.json({ url });
  } catch (err: any) {
    console.error(`[portal] billing portal session failed for tenant ${tenant.id}:`, err);
    res.status(400).json({ error: err?.message || "Could not open the billing portal" });
  }
});

const VISIT_LOGGING_MODES = ["off", "notes", "activities"] as const;

/**
 * Lets a client choose whether individual website visits (page + time on
 * page) get written to Pipedrive as Notes, as Activities, or not at all
 * — separate from the always-on custom-fields sync, since this one adds
 * an entry per visit rather than just keeping a handful of fields
 * current, and some reps will find that noisy. See
 * lib/pipedrive-sync.ts's logWebsiteVisit for where this setting is read.
 */
portalRouter.post("/api/settings/visit-logging", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const mode = req.body?.mode;
  if (!VISIT_LOGGING_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${VISIT_LOGGING_MODES.join(", ")}` });
  }
  await db.tenant.updateVisitLogging(tenant.id, mode);
  res.json({ ok: true, pipedriveVisitLogging: mode });
});

/**
 * CSV downloads for the two dashboard tables — uncapped (unlike the
 * summary endpoint, which caps "recent"/"topCampaigns" for what's
 * reasonable to render as HTML) so a client gets everything, not just
 * what's currently visible on screen. A plain browser navigation (not a
 * fetch) hits these, so auth is the same session cookie as everything
 * else in this router — no separate token needed.
 */
portalRouter.get("/api/export/prospects.csv", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const [identities, touchpoints] = await Promise.all([
    db.identity.findMany({ where: { tenantId: tenant.id } }),
    db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } }),
  ]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="prospects.csv"');
  res.send(buildProspectsCsv(identities, touchpoints, tenant.pipedriveCompanyDomain));
});

portalRouter.get("/api/export/campaigns.csv", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const touchpoints = await db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="campaigns.csv"');
  res.send(buildCampaignsCsv(touchpoints));
});

portalRouter.get("/api/summary", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const [identities, touchpoints] = await Promise.all([
    db.identity.findMany({ where: { tenantId: tenant.id } }),
    db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } }),
  ]);
  const summary = buildPortalSummary(identities, touchpoints);
  // Attach the actual clickable Pipedrive link here, not in
  // buildPortalSummary — that function stays a pure, tenant-domain-agnostic
  // unit (see verify-portal.ts), while only this route knows the tenant's
  // pipedriveCompanyDomain needed to build a real URL.
  const recentWithLinks = summary.recent.map((r) => ({
    ...r,
    pipedriveUrl: r.pipedrivePersonId
      ? deepLinkForPerson(tenant.pipedriveCompanyDomain, r.pipedrivePersonId)
      : null,
  }));
  res.json({ ...summary, recent: recentWithLinks });
});

/**
 * Shared shape for a touchpoint as sent to the browser — used by both
 * the session-authenticated prospects route below and the token-authed
 * journey route further down, so the two timeline views (the dashboard's
 * expandable row, and the standalone journey.html page a Pipedrive field
 * links to) are always fed identical data and can share rendering code
 * (see public/timeline.js).
 */
function touchpointToApiShape(tp: Touchpoint) {
  return {
    id: tp.id,
    channel: tp.channel,
    source: tp.source,
    campaign: tp.campaign,
    medium: tp.medium,
    term: tp.term,
    content: tp.content,
    url: tp.url,
    title: tp.title,
    referrer: tp.referrer,
    gclid: tp.gclid,
    fbclid: tp.fbclid,
    msclkid: tp.msclkid,
    durationMs: tp.durationMs,
    occurredAt: tp.occurredAt.toISOString(),
  };
}

/**
 * Full touchpoint history for one prospect, in the order they happened —
 * what "Recently active prospects" expands into on click. Deliberately
 * scoped by tenantId on both lookups (not just the identityId from the
 * URL) so one tenant can never pull another's data by guessing an id —
 * same defense-in-depth as everywhere else identityId crosses a trust
 * boundary in this app.
 */
portalRouter.get("/api/prospects/:identityId", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const identity = await db.identity.findUnique({ where: { tenantId: tenant.id, id: req.params.identityId } });
  if (!identity) return res.status(404).json({ error: "Not found" });

  const touchpoints = await db.touchpoint.findMany({
    where: { tenantId: tenant.id, identityId: identity.id },
    orderBy: { occurredAt: "asc" },
  });

  res.json({
    identity: {
      id: identity.id,
      email: identity.email,
      pipedrivePersonId: identity.pipedrivePersonId,
      pipedriveUrl: identity.pipedrivePersonId
        ? deepLinkForPerson(tenant.pipedriveCompanyDomain, identity.pipedrivePersonId)
        : null,
    },
    touchpoints: touchpoints.map(touchpointToApiShape),
  });
});

/**
 * The token-authed twin of the route above — same data, same shape, but
 * reached by clicking the "AS: View Journey" link on a Pipedrive
 * Person/Deal (see lib/pipedrive-sync.ts) rather than from inside the
 * logged-in dashboard. Deliberately NOT behind requireSession: a rep
 * clicking that field isn't necessarily logged into the separate
 * self-serve portal, and this is meant to be one click, not a login
 * detour. Instead it trusts a per-identity signed token (see
 * lib/journey-link.ts) passed as ?token=, alongside ?tenant= identifying
 * which tenant's webhookSecret to verify it against — the tenant scoping
 * still applies here (a token only verifies against the ONE tenant it
 * names, and a tenant's own identities are still looked up by
 * tenantId+id), it's just carried in the query string instead of a
 * session cookie.
 */
portalRouter.get("/api/journey/:identityId", async (req, res) => {
  const tenantId = String(req.query.tenant || "");
  const token = typeof req.query.token === "string" ? req.query.token : undefined;
  if (!tenantId) return res.status(400).json({ error: "Missing tenant" });

  const tenant = await db.tenant.findById(tenantId);
  if (!tenant) return res.status(404).json({ error: "Not found" });

  if (!verifyJourneyToken(tenant, req.params.identityId, token)) {
    return res.status(403).json({ error: "Invalid link" });
  }

  const identity = await db.identity.findUnique({ where: { tenantId: tenant.id, id: req.params.identityId } });
  if (!identity) return res.status(404).json({ error: "Not found" });

  const touchpoints = await db.touchpoint.findMany({
    where: { tenantId: tenant.id, identityId: identity.id },
    orderBy: { occurredAt: "asc" },
  });

  res.json({
    identity: {
      id: identity.id,
      email: identity.email,
      pipedrivePersonId: identity.pipedrivePersonId,
      pipedriveUrl: identity.pipedrivePersonId
        ? deepLinkForPerson(tenant.pipedriveCompanyDomain, identity.pipedrivePersonId)
        : null,
    },
    touchpoints: touchpoints.map(touchpointToApiShape),
  });
});

// Password reset intentionally isn't built yet — flagged in the README
// as a known gap rather than left silently missing. A client who
// forgets their password today needs the tenant owner to reset it
// directly in the tenants table (db.tenant.create's passwordHash column)
// until this exists.
