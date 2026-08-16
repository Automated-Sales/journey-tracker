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

// The self-serve portal (/attribution) — marketing page, signup, login,
// and the aggregated client dashboard. Session-cookie authenticated, not
// tenant-slug/key authenticated, since a visitor doesn't know their
// tenant slug until after they've signed up. See routes/portal.ts.
app.use(portalRouter);

// Clean URLs for the portal's static pages. Registered BEFORE
// express.static below on purpose: express.static would otherwise treat
// public/attribution as a directory request and 301-redirect
// /attribution -> /attribution/ before ever reaching a route registered
// after it, which isn't the URL shape we want. The files themselves also
// remain directly reachable (e.g. /attribution/style.css) via the static
// middleware for CSS/JS assets.
const attributionPage = (file: string) => (_req: express.Request, res: express.Response) =>
  res.sendFile(path.join(__dirname, "..", "public", "attribution", file));
app.get("/attribution", attributionPage("index.html"));
app.get("/attribution/signup", attributionPage("signup.html"));
app.get("/attribution/login", attributionPage("login.html"));
app.get("/attribution/dashboard", attributionPage("dashboard.html"));
// Standalone, no-login "View full journey" page — see routes/portal.ts's
// /attribution/api/journey/:identityId and lib/journey-link.ts. Static
// file for every prospect; the page itself reads identityId from the URL
// path and the tenant+token from the query string client-side.
app.get("/attribution/journey/:identityId", attributionPage("journey.html"));

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
