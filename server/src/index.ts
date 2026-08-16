import "dotenv/config";
import path from "path";
import express from "express";
import cors from "cors";
import { trackRouter } from "./routes/track";
import { identifyRouter } from "./routes/identify";
import { journeyRouter } from "./routes/journey";
import { webhooksRouter } from "./routes/webhooks";
import { portalRouter } from "./routes/portal";

const app = express();

// Behind Caddy/nginx in production — trust the X-Forwarded-Proto/Host
// headers they set so req.protocol reports "https" instead of "http".
// Used to build the tenant install snippet shown on the dashboard when
// PUBLIC_BASE_URL isn't set explicitly. See routes/portal.ts.
app.set("trust proxy", true);

app.use(express.json({ limit: "1mb" }));

// This server is called from an open-ended, growing set of client
// websites (one per tenant we onboard) — there's no static list of
// origins to allowlist ahead of time. The tracking snippet's actual
// authorization comes from each tenant's trackKey (see
// tenant-middleware.ts), not from CORS, so reflecting any origin here is
// safe: a stolen/guessed key is the real thing to protect against, and
// CORS doesn't protect against that anyway (a server-side curl ignores
// CORS entirely).
//
// credentials: true is required, not optional, for the tracking snippet
// to work at all when the client site and this server are on genuinely
// different domains (e.g. automated-sales.com calling
// attribution.automated-sales.co — different second-level domains, so
// this is cross-site, not just cross-origin). navigator.sendBeacon's
// cross-site JSON requests are sent with credentials included, and
// Chrome enforces a real CORS credentials check on those — without this
// flag, Access-Control-Allow-Credentials is absent from our responses
// and the browser blocks the request outright with a CORS error,
// regardless of how correct the Origin reflection above is.
app.use(cors({ origin: true, credentials: true }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "journey-tracker", time: new Date().toISOString() }));

// The self-serve portal — marketing page, signup, login, and the
// aggregated client dashboard. Session-cookie authenticated, not
// tenant-slug/key authenticated, since a visitor doesn't know their
// tenant slug until after they've signed up. See routes/portal.ts.
app.use(portalRouter);

// Clean root URLs for the portal's static pages. This app lives on its
// own dedicated subdomain (attribution.automated-sales.co), which
// already says "attribution" once — repeating it in every path
// (/attribution/dashboard) was redundant, hence plain root paths here.
// Registered BEFORE express.static below on purpose: an earlier route
// always wins over the static middleware for the same path.
const portalPage = (file: string) => (_req: express.Request, res: express.Response) =>
  res.sendFile(path.join(__dirname, "..", "public", file));
app.get("/", portalPage("index.html"));
app.get("/signup", portalPage("signup.html"));
app.get("/login", portalPage("login.html"));
app.get("/dashboard", portalPage("dashboard.html"));
// Standalone, no-login "View full journey" page — see routes/portal.ts's
// /api/journey/:identityId and lib/journey-link.ts. Static file for
// every prospect; the page itself reads identityId from the URL path and
// the tenant+token from the query string client-side.
app.get("/journey/:identityId", portalPage("journey.html"));

// Backward-compat redirects for the old /attribution/* URLs (the shape
// every page used before the subdomain move above). Not just "some old
// bookmark" — the journey one especially is baked as literal saved text
// into every "AS: View Journey" Pipedrive custom field pushed before
// this change (see lib/journey-link.ts), so breaking it silently would
// strand already-issued links sitting in a client's live Pipedrive data.
// 301 (permanent) since these should never come back; the journey
// redirect preserves the query string, which carries the tenant + signed
// token the new route still needs to verify.
app.get("/attribution", (_req, res) => res.redirect(301, "/"));
app.get("/attribution/signup", (_req, res) => res.redirect(301, "/signup"));
app.get("/attribution/login", (_req, res) => res.redirect(301, "/login"));
app.get("/attribution/dashboard", (_req, res) => res.redirect(301, "/dashboard"));
app.get("/attribution/journey/:identityId", (req, res) => {
  const queryString = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, `/journey/${encodeURIComponent(req.params.identityId)}${queryString}`);
});

// The tracking snippet is hosted here, once, for every client — see
// public/automated-sales-tracker.js and tracking-snippet/README.md.
// Short cache lifetime so a snippet fix rolls out to every client's site
// within minutes rather than however long a browser/CDN would otherwise
// hold onto it, since this is a single shared file everyone points at.
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    maxAge: "5m",
  })
);

// Every tenant-scoped route lives under /t/:tenant/... — see
// routes/tenant-middleware.ts for how :tenant resolves to a Tenant row.
app.use("/t/:tenant/api", trackRouter);
app.use("/t/:tenant/api", identifyRouter);
app.use("/t/:tenant/api", journeyRouter);
app.use("/t/:tenant", webhooksRouter);

// Tenants (client businesses) are managed via CLI, not an HTTP admin API
// — see `npm run add-tenant` and `npm run list-tenants`. Keeps the
// public server surface limited to what clients' own systems call.

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`Journey Tracker API listening on :${port}`);
});
