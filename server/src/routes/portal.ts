import { Router, Request, Response, NextFunction } from "express";
import { db, Tenant, Touchpoint } from "../db";
import { getMe, deepLinkForPerson, listDealFields, listPersonFields, listLeadLabels } from "../lib/pipedrive";
import { setupPipedriveFields } from "../lib/pipedrive-field-setup";
import { validateSignupForm, provisionSelfServeTenant } from "../lib/portal-signup";
import { buildPortalSummary, filterProspects, filterIdentities, paginateProspects, ProspectFilter, UtmFilter } from "../lib/portal-summary";
import { buildProspectsCsv, buildCampaignsCsv, buildGoogleAdsConversionsCsv, buildMicrosoftAdsConversionsCsv, buildLinkedInAdsConversionsCsv } from "../lib/csv";
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
 * Stage 2 of the lead-source-field feature (Stage 1 was the CLI script,
 * set-tenant-lead-source-field.ts — still works, this is the same thing
 * through the dashboard instead). See db.ts's Tenant interface doc
 * comment on leadSourceFieldKey for the full reasoning.
 *
 * Fetches the tenant's Lead/Deal field list live from Pipedrive on every
 * load (not cached) — this is a settings page someone visits rarely, and
 * a field a client added yesterday should show up immediately rather
 * than waiting on some cache to expire.
 */
portalRouter.get("/api/settings/lead-source-field", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const current = tenant.leadSourceFieldKey
    ? { key: tenant.leadSourceFieldKey, name: tenant.leadSourceFieldLabel }
    : null;

  if (!tenant.pipedriveApiToken) {
    return res.json({ current, fields: [], error: "No Pipedrive API token configured for this tenant yet." });
  }

  try {
    const fields = await listDealFields(tenant.pipedriveApiToken);
    const options = fields
      .filter((f: any) => typeof f.name === "string" && typeof f.key === "string")
      .map((f: any) => ({ key: f.key, name: f.name }))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    res.json({ current, fields: options });
  } catch (err: any) {
    console.error(`[settings] failed to list Pipedrive fields for tenant ${tenant.id}:`, err);
    res.status(502).json({ current, fields: [], error: "Couldn't fetch fields from Pipedrive — check the API token is still valid." });
  }
});

/**
 * Re-validates the chosen key against Pipedrive's live field list before
 * saving (rather than trusting whatever the client sent) — cheap
 * insurance against saving a stale reference to a field a client renamed
 * or deleted between page load and clicking Save.
 */
portalRouter.post("/api/settings/lead-source-field", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const key = req.body?.key;

  if (!key) {
    await db.tenant.updateLeadSourceField(tenant.id, { leadSourceFieldKey: null, leadSourceFieldLabel: null });
    return res.json({ ok: true, current: null });
  }

  if (!tenant.pipedriveApiToken) {
    return res.status(400).json({ error: "No Pipedrive API token configured for this tenant." });
  }

  try {
    const fields = await listDealFields(tenant.pipedriveApiToken);
    const match = fields.find((f: any) => f.key === key);
    if (!match) {
      return res.status(400).json({ error: "That field no longer exists in Pipedrive — refresh the page and try again." });
    }
    await db.tenant.updateLeadSourceField(tenant.id, { leadSourceFieldKey: match.key, leadSourceFieldLabel: match.name });
    res.json({ ok: true, current: { key: match.key, name: match.name } });
  } catch (err: any) {
    console.error(`[settings] failed to save lead-source field for tenant ${tenant.id}:`, err);
    res.status(502).json({ error: "Couldn't verify that field against Pipedrive — try again." });
  }
});

/**
 * The segment field setting (Johari's use case: Pipedrive Label,
 * generalized to any field a client wants to segment by — see db.ts's
 * Tenant.segmentFieldKey doc comment). Same GET/POST pattern as
 * lead-source-field above, but this one also has to capture and cache
 * the field's OPTIONS (id -> readable name) on save, since Pipedrive
 * stores an option ID on the record, not the name — see
 * lib/portal-summary.ts's resolveSegmentName.
 */
/**
 * Pipedrive Labels — and other segmentation-style fields — can live on
 * either the Person or the Deal/Lead record (they're separate field
 * definitions with separate keys, even when both happen to be called
 * "Label"). Johari's own turned out to be the PERSON one, not the Deal
 * one this route originally only queried — so both are now offered,
 * clearly distinguished, and it doesn't matter which the tenant picks:
 * captureSegmentValue (webhooks.ts) is called from the person, deal,
 * AND lead handlers, and simply no-ops on whichever ones don't have
 * this particular field key in their payload.
 */
// Pipedrive's own built-in Label field uses the same literal key
// ("label") on BOTH Person and Deal — they're genuinely separate
// fields in separate namespaces, but sharing that key name meant the
// two dropdown options collided under one value, so picking either one
// silently saved the same ambiguous key (and worse: reading it back
// could pull the WRONG entity's Label depending on which webhook
// happened to fire next). Fixed by prefixing the stored key with which
// entity it came from ("person::label" vs "deal::label") — see
// webhooks.ts's captureSegmentValue, which now checks this prefix
// against the entity of whichever webhook it's currently processing
// before reading anything.
//
// A further wrinkle, confirmed via debug-segment-field.ts against a
// real record: Pipedrive's BUILT-IN Label field has a split identity —
// its field DEFINITION (where the {id, name} options live, needed to
// resolve a captured value into something readable) is keyed "label",
// but every actual record stores its value under a totally different,
// literal top-level property: "label_ids" (a plain array, e.g. [412] —
// not nested in custom_fields the way regular custom fields are).
// Reading `data["label"]` off any real payload — webhook or live GET —
// finds nothing. Special-cased below: when a field's own key is
// exactly "label", the field is exposed to the settings dropdown under
// "label_ids" instead, so whichever key gets saved and later read back
// by captureSegmentValue is the one that actually appears on real data.
function normalizeFieldKeyForCapture(key: string): string {
  return key === "label" ? "label_ids" : key;
}

async function listSegmentableFields(token: string): Promise<{ key: string; name: string; options: any }[]> {
  const [personFields, dealFields, leadLabels] = await Promise.all([listPersonFields(token), listDealFields(token), listLeadLabels(token)]);
  const named = (fields: any[], entityPrefix: string, suffix: string) =>
    fields
      .filter((f: any) => typeof f.name === "string" && typeof f.key === "string")
      .map((f: any) => {
        let options = f.options;
        // Deal's built-in "label" field and Lead's own /leadLabels are
        // two DIFFERENT ID namespaces (small integers vs UUIDs — see
        // lib/pipedrive.ts's listLeadLabels doc comment) that both end
        // up captured under the same runtime property, label_ids, once
        // normalizeFieldKeyForCapture combines them into one dropdown
        // entry below. Merging Lead's options in here too means that
        // ONE entry's cached options can resolve EITHER shape of ID
        // correctly, regardless of whether a given identity's segment
        // came from a Deal or a Lead webhook.
        if (f.key === "label" && entityPrefix === "deal") {
          options = [...(Array.isArray(f.options) ? f.options : []), ...leadLabels.map((l) => ({ id: l.id, label: l.name }))];
        }
        return { key: `${entityPrefix}::${normalizeFieldKeyForCapture(f.key)}`, name: `${f.name} (${suffix})`, options };
      });
  return [...named(personFields, "person", "Person"), ...named(dealFields, "deal", "Deal/Lead")].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

portalRouter.get("/api/settings/segment-field", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const current = tenant.segmentFieldKey ? { key: tenant.segmentFieldKey, name: tenant.segmentFieldLabel } : null;

  if (!tenant.pipedriveApiToken) {
    return res.json({ current, fields: [], error: "No Pipedrive API token configured for this tenant yet." });
  }

  try {
    const fields = await listSegmentableFields(tenant.pipedriveApiToken);
    res.json({ current, fields: fields.map((f) => ({ key: f.key, name: f.name })) });
  } catch (err: any) {
    console.error(`[settings] failed to list Pipedrive fields for tenant ${tenant.id}:`, err);
    res.status(502).json({ current, fields: [], error: "Couldn't fetch fields from Pipedrive — check the API token is still valid." });
  }
});

portalRouter.post("/api/settings/segment-field", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const key = req.body?.key;

  if (!key) {
    await db.tenant.updateSegmentField(tenant.id, { segmentFieldKey: null, segmentFieldLabel: null, segmentFieldOptions: null });
    return res.json({ ok: true, current: null });
  }

  if (!tenant.pipedriveApiToken) {
    return res.status(400).json({ error: "No Pipedrive API token configured for this tenant." });
  }

  try {
    const fields = await listSegmentableFields(tenant.pipedriveApiToken);
    const match = fields.find((f) => f.key === key);
    if (!match) {
      return res.status(400).json({ error: "That field no longer exists in Pipedrive — refresh the page and try again." });
    }
    // Only enum/set-type fields (Label included) carry an `options`
    // array — a plain text field wouldn't, and that's fine: raw and
    // readable value are then the same thing, so resolveSegmentName's
    // fallback (return the raw value as-is when no match is found)
    // already handles it correctly with an empty options list.
    const options = Array.isArray(match.options)
      ? match.options.map((o: any) => ({ id: String(o.id), name: String(o.label) }))
      : [];
    await db.tenant.updateSegmentField(tenant.id, {
      segmentFieldKey: match.key,
      segmentFieldLabel: match.name,
      segmentFieldOptions: JSON.stringify(options),
    });
    res.json({ ok: true, current: { key: match.key, name: match.name } });
  } catch (err: any) {
    console.error(`[settings] failed to save segment field for tenant ${tenant.id}:`, err);
    res.status(502).json({ error: "Couldn't verify that field against Pipedrive — try again." });
  }
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
  // Defaults to true (include everyone) so any link/bookmark without the
  // param keeps its old, pre-toggle behavior — the dashboard's own
  // download link explicitly appends ?anonymous=0/1 based on the "Show
  // anonymous" checkbox state, see dashboard.html.
  const includeAnonymous = req.query.anonymous !== "0";
  const [identities, touchpoints] = await Promise.all([
    db.identity.findMany({ where: { tenantId: tenant.id } }),
    db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } }),
  ]);
  // Routed through filterIdentities with the neutral "total" funnel
  // filter (matches every identity, same as no filter at all) purely so
  // an active UTM filter still applies — when parseUtmFilterQuery
  // returns an empty filter (the common case, no UTM params on this
  // request), matchesUtmFilter always returns true and this is exactly
  // equivalent to using the raw `identities` array, so this doesn't
  // change behavior for the default, unfiltered "Download CSV" click.
  const matched = filterIdentities(identities, touchpoints, { type: "funnel", value: "total" }, parseUtmFilterQuery(req));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="prospects.csv"');
  res.send(buildProspectsCsv(matched, touchpoints, tenant.pipedriveCompanyDomain, includeAnonymous, parseSegmentOptions(tenant)));
});

portalRouter.get("/api/export/campaigns.csv", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const touchpoints = await db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="campaigns.csv"');
  res.send(buildCampaignsCsv(touchpoints));
});

/**
 * The dashboard's "Google Ads conversion feedback" card — see
 * lib/csv.ts's buildGoogleAdsConversionsCsv doc comment for the full
 * design (why two conversion events, why value/currency are blank,
 * where the exact file format came from).
 */
portalRouter.get("/api/export/google-ads-conversions.csv", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const [identities, touchpoints] = await Promise.all([
    db.identity.findMany({ where: { tenantId: tenant.id } }),
    db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } }),
  ]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="google-ads-conversions.csv"');
  res.send(buildGoogleAdsConversionsCsv(identities, touchpoints));
});

/**
 * Same idea as the Google Ads export above, for Microsoft Advertising —
 * see lib/csv.ts's buildMicrosoftAdsConversionsCsv doc comment.
 */
portalRouter.get("/api/export/microsoft-ads-conversions.csv", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const [identities, touchpoints] = await Promise.all([
    db.identity.findMany({ where: { tenantId: tenant.id } }),
    db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } }),
  ]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="microsoft-ads-conversions.csv"');
  res.send(buildMicrosoftAdsConversionsCsv(identities, touchpoints));
});

/** See lib/csv.ts's buildLinkedInAdsConversionsCsv doc comment — the
 *  least-verified of the three ad exports, worth checking the column
 *  headers against LinkedIn's own downloadable template before first
 *  use. */
portalRouter.get("/api/export/linkedin-ads-conversions.csv", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const [identities, touchpoints] = await Promise.all([
    db.identity.findMany({ where: { tenantId: tenant.id } }),
    db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } }),
  ]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="linkedin-ads-conversions.csv"');
  res.send(buildLinkedInAdsConversionsCsv(identities, touchpoints));
});

// Shared by /api/summary, /api/prospects/filtered, and
// /api/export/prospects-filtered.csv — the global UTM filter bar's
// ?utm_source=/?utm_medium=/?utm_campaign=/?utm_term=/?utm_content=
// query params, parsed the same way everywhere so a filtered dashboard
// and its drill-down popups/exports can never silently disagree about
// which segment is active. Prefixed utm_ (unlike ?by=/?value= above) to
// avoid colliding with the drill-down's own ?value= param when both are
// present on the same request (a funnel-stage click while a UTM filter
// is already active hits /api/prospects/filtered with both sets of
// params at once).
function parseUtmFilterQuery(req: Request): UtmFilter {
  const filter: UtmFilter = {};
  if (req.query.utm_source) filter.source = String(req.query.utm_source);
  if (req.query.utm_medium) filter.medium = String(req.query.utm_medium);
  if (req.query.utm_campaign) filter.campaign = String(req.query.utm_campaign);
  if (req.query.utm_term) filter.term = String(req.query.utm_term);
  if (req.query.utm_content) filter.content = String(req.query.utm_content);
  if (req.query.segment) filter.segment = String(req.query.segment);
  return filter;
}

// Parses a tenant's cached segmentFieldOptions JSON into the {id, name}
// array buildPortalSummary/filterProspects/paginateProspects expect —
// one place for this so a malformed/missing value never crashes a
// request, just degrades to "no options, raw IDs shown as-is."
function parseSegmentOptions(tenant: { segmentFieldOptions: string | null }): { id: string; name: string }[] {
  if (!tenant.segmentFieldOptions) return [];
  try {
    const parsed = JSON.parse(tenant.segmentFieldOptions);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

portalRouter.get("/api/summary", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const [identities, touchpoints] = await Promise.all([
    db.identity.findMany({ where: { tenantId: tenant.id } }),
    db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } }),
  ]);
  const summary = buildPortalSummary(identities, touchpoints, parseUtmFilterQuery(req), parseSegmentOptions(tenant));
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
 * Real pagination for the "Recently active prospects" table — unlike
 * /api/summary's own `recent` field (capped at 25 for a quick preview),
 * this returns however many prospects actually match, one page at a
 * time. Same ?utm_source=/etc and ?anonymous=0/1 query params as
 * everywhere else on this dashboard, so pagination composes correctly
 * with both the segment filter bar and the anonymous toggle.
 *   ?page=2&pageSize=50
 */
portalRouter.get("/api/prospects", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  // Capped at 200 — this endpoint is meant for stepping through pages of
  // a table a person is actually reading, not bulk data extraction (the
  // CSV export routes exist for that, and return everything in one go
  // regardless of this cap).
  const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize || "50"), 10) || 50));
  const includeAnonymous = req.query.anonymous !== "0";
  const utmFilter = parseUtmFilterQuery(req);

  const [identities, touchpoints] = await Promise.all([
    db.identity.findMany({ where: { tenantId: tenant.id } }),
    db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } }),
  ]);
  const { prospects, total } = paginateProspects(identities, touchpoints, {
    utmFilter,
    includeAnonymous,
    page,
    pageSize,
    segmentOptions: parseSegmentOptions(tenant),
  });
  const prospectsWithLinks = prospects.map((r) => ({
    ...r,
    pipedriveUrl: r.pipedrivePersonId ? deepLinkForPerson(tenant.pipedriveCompanyDomain, r.pipedrivePersonId) : null,
  }));
  res.json({ prospects: prospectsWithLinks, total, page, pageSize });
});

const FUNNEL_VALUES = ["total", "identified", "lead", "deal", "won"];

// Shared by /api/prospects/filtered (JSON, for the dashboard popup) and
// /api/export/prospects-filtered.csv (the popup's Download CSV button)
// below — one parsing/validation implementation so the two routes can
// never interpret the same ?by=/?value= pair differently.
function parseProspectFilterQuery(req: Request): ProspectFilter | { error: string } {
  const by = String(req.query.by || "");
  const value = String(req.query.value ?? "");
  if (!value) return { error: "value is required" };

  if (by === "funnel") {
    if (!FUNNEL_VALUES.includes(value)) return { error: `value must be one of: ${FUNNEL_VALUES.join(", ")}` };
    return { type: "funnel", value: value as "total" | "identified" | "lead" | "deal" | "won" };
  }
  if (by === "source") return { type: "source", value };
  if (by === "campaign") return { type: "campaign", value };
  if (by === "segment") return { type: "segment", value };
  if (by === "assistedChannel") return { type: "assistedChannel", value };
  return { error: "by must be one of: funnel, source, campaign, segment, assistedChannel" };
}

/**
 * Powers the dashboard's click-through drill-down (funnel stages,
 * conversion-by-source rows, campaign-performance rows) — see
 * lib/portal-summary.ts's filterProspects for why this recomputes from
 * the full identity list rather than reusing /api/summary's own
 * (25-capped) `recent` array. Query params:
 *   ?by=funnel&value=lead|deal|won|identified|total
 *   ?by=source&value=<exact firstTouchSource string>
 *   ?by=campaign&value=<exact firstTouchCampaign string>
 */
portalRouter.get("/api/prospects/filtered", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const filter = parseProspectFilterQuery(req);
  if ("error" in filter) return res.status(400).json({ error: filter.error });
  const utmFilter = parseUtmFilterQuery(req);

  const [identities, touchpoints] = await Promise.all([
    db.identity.findMany({ where: { tenantId: tenant.id } }),
    db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } }),
  ]);
  const prospects = filterProspects(identities, touchpoints, filter, utmFilter, parseSegmentOptions(tenant));
  // Same pipedriveUrl attachment as /api/summary above, kept consistent
  // so the filtered table can render with identical "Pipedrive" column
  // links.
  const prospectsWithLinks = prospects.map((r) => ({
    ...r,
    pipedriveUrl: r.pipedrivePersonId ? deepLinkForPerson(tenant.pipedriveCompanyDomain, r.pipedrivePersonId) : null,
  }));
  res.json({ prospects: prospectsWithLinks });
});

/**
 * The popup's "Download CSV" button — same filter query params as
 * /api/prospects/filtered above, plus the same ?anonymous=0/1 the main
 * export already supports (see /api/export/prospects.csv), so the
 * popup's own "Show anonymous" toggle controls this export the same way
 * it controls the on-screen table. Returns the actual downloadable file
 * (reusing buildProspectsCsv, the exact same function/format the main
 * "Download CSV" button under Recently active prospects already uses)
 * instead of JSON. Deliberately CSV, not a true .xlsx binary: this app
 * has no spreadsheet-writing dependency, and a .csv opens directly in
 * Excel with a double-click on every platform, so there's no real
 * functionality gap — just avoids adding a new dependency for something
 * a plain-text format already covers.
 */
portalRouter.get("/api/export/prospects-filtered.csv", requireSession, requireActiveBilling, async (req, res) => {
  const tenant = req.portalTenant!;
  const filter = parseProspectFilterQuery(req);
  if ("error" in filter) return res.status(400).json({ error: filter.error });
  const includeAnonymous = req.query.anonymous !== "0";
  const utmFilter = parseUtmFilterQuery(req);

  const [identities, touchpoints] = await Promise.all([
    db.identity.findMany({ where: { tenantId: tenant.id } }),
    db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } }),
  ]);
  const matched = filterIdentities(identities, touchpoints, filter, utmFilter);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="prospects-filtered.csv"');
  res.send(buildProspectsCsv(matched, touchpoints, tenant.pipedriveCompanyDomain, includeAnonymous, parseSegmentOptions(tenant)));
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
