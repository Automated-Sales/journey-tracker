import { Router, Request, Response, NextFunction } from "express";
import { db, Tenant, Touchpoint } from "../db";
import { getMe, deepLinkForPerson } from "../lib/pipedrive";
import { setupPipedriveFields } from "../lib/pipedrive-field-setup";
import { validateSignupForm, provisionSelfServeTenant } from "../lib/portal-signup";
import { buildPortalSummary } from "../lib/portal-summary";
import { buildProspectsCsv, buildCampaignsCsv } from "../lib/csv";
import { verifyJourneyToken } from "../lib/journey-link";
import {
  verifyPassword,
  getSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  SESSION_TTL_MS,
} from "../lib/auth";

// Public-facing routes for the /attribution self-serve portal (marketing
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
 * Validates the pasted Pipedrive token live (same call add-tenant's
 * operator would eyeball manually), creates the tenant, then best-effort
 * runs the exact same custom-field setup `npm run setup:pipedrive` does —
 * so a self-serve client doesn't need to know that CLI command exists.
 * Field setup failing does NOT fail the signup: tracking + the dashboard
 * both work without it, same as the CLI path (see pipedrive-sync.ts,
 * which already no-ops cleanly when personFieldMap isn't set yet).
 */
portalRouter.post("/attribution/api/signup", async (req, res) => {
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
  res.status(201).json({ tenantId: tenant.id, name: tenant.name });
});

portalRouter.post("/attribution/api/login", async (req, res) => {
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

portalRouter.post("/attribution/api/logout", async (req, res) => {
  const token = getSessionCookie(req);
  if (token) await db.session.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

portalRouter.get("/attribution/api/me", requireSession, (req, res) => {
  const tenant = req.portalTenant!;
  res.json({
    tenantId: tenant.id,
    name: tenant.name,
    email: tenant.signupEmail,
    install: buildInstallInfo(req, tenant),
    pipedriveVisitLogging: tenant.pipedriveVisitLogging,
  });
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
portalRouter.post("/attribution/api/settings/visit-logging", requireSession, async (req, res) => {
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
portalRouter.get("/attribution/api/export/prospects.csv", requireSession, async (req, res) => {
  const tenant = req.portalTenant!;
  const [identities, touchpoints] = await Promise.all([
    db.identity.findMany({ where: { tenantId: tenant.id } }),
    db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } }),
  ]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="prospects.csv"');
  res.send(buildProspectsCsv(identities, touchpoints, tenant.pipedriveCompanyDomain));
});

portalRouter.get("/attribution/api/export/campaigns.csv", requireSession, async (req, res) => {
  const tenant = req.portalTenant!;
  const touchpoints = await db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="campaigns.csv"');
  res.send(buildCampaignsCsv(touchpoints));
});

portalRouter.get("/attribution/api/summary", requireSession, async (req, res) => {
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
 * (see public/attribution/timeline.js).
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
portalRouter.get("/attribution/api/prospects/:identityId", requireSession, async (req, res) => {
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
portalRouter.get("/attribution/api/journey/:identityId", async (req, res) => {
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
