# Prospect Journey Tracker — for Pipedrive (Automated Sales)

Captures a prospect's full path — ad clicks, website visits, email
engagement, and every sales activity already logged in Pipedrive — and
gets it in front of a rep in Pipedrive two independent ways. Built as a
multi-tenant service so it can be rolled out to multiple client
businesses, each with their own Pipedrive account, their own website,
and their own data, from one deployment.

This solves the exact problem described in the LinkedIn post this was
built from: last-click attribution hides the LinkedIn post and the blog
read that happened weeks before someone Googled the brand and signed up.
This tool keeps the whole path, in order, attached to the record a rep
actually opens.

There's also a self-serve front door — `/attribution` (see "Self-serve
portal" below) — for a client to connect their own Pipedrive and see an
aggregated dashboard, without you running the CLI onboarding by hand.

## Multi-tenant: one deployment, many clients

One server, one database, many client businesses ("tenants"). Every
route is scoped by a tenant slug (`/t/acme-co/...`); every Identity and
Touchpoint row is scoped by `tenantId` in the database, and it's not just
assumed — `npm run smoke-test` runs the full journey twice, for two
different tenants, on the *same email address*, and asserts they resolve
to two completely separate identities with zero cross-visibility. Each
tenant gets their own Pipedrive API token, their own webhook secret, and
their own tracking-snippet key, so one client's snippet or webhook can
never read or write another client's data (see `routes/tenant-middleware.ts`).

The panel (visual timeline) is a **single shared deployment** — you build
and host it once, and each client's own Pipedrive account points its
private-app iframe at that same URL with a `?tenant=<their-slug>` query
param. The backend is also one deployment. What's per-client is: a row
in the `tenants` table, a snippet install on their site, and (for the
panel) one small registration step in their own Pipedrive Developer Hub.

## Onboarding a new client, end to end

```bash
cd server
npm run add-tenant -- --slug acme-co --name "Acme Co" \
  --pipedrive-token <their Pipedrive API token> \
  --pipedrive-domain acme-co-pipedrive \
  --base-url https://journey-api.yourdomain.com
```

This prints everything needed to wire that client up — hand each numbered
block to whoever's doing that piece of the install:

1. **Website** — a `<script>` block (their tenant's API URL + track key
   baked in), plus a note that most forms are picked up automatically. See
   "Installing the snippet on a client's site" below for four ways to
   actually get it onto their pages, depending on what they're comfortable
   editing.
2. **LinkedIn Ads** — one checkbox, no install: "Enable enhanced
   conversion tracking" in their Campaign Manager account settings. I
   checked this rather than assumed — `li_fat_id` isn't automatic like
   Google's `gclid`, which *is* on by default for every Google Ads
   account, so nothing's needed there.
3. **Email tool** — a webhook URL (their tenant's secret baked in) to
   paste into their ESP's settings for open/click/reply events. Which
   exact fields to map depends on which ESP they use — the mapping block
   is in `server/src/routes/webhooks.ts`, clearly marked, and needs one
   adjustment per new ESP we haven't wired up before.
4. **Pipedrive webhook** — a URL + list of events to register in their
   Pipedrive (Settings → Tools and apps → Webhooks).
5. **Pipedrive custom fields** — reminds you to run
   `npm run setup:pipedrive -- --tenant acme-co` once their token is set,
   which creates the fields in their account (see below).
6. **Panel iframe URL** (optional) — the shared panel's URL with their
   tenant slug appended, to paste into their own Developer Hub
   registration; see `pipedrive-app/README.md`.

Nothing here requires touching code per client — it's all config values
generated once and handed off. `npm run list-tenants` shows who's
onboarded and what's still missing for each.

## Installing the snippet on a client's site

The snippet itself (`server/public/automated-sales-tracker.js`) is hosted
once, centrally, by this backend at
`<your-deployed-api-url>/automated-sales-tracker.js` — no client ever
needs to upload a JS file to their own site. What's per-client is just the
two config values `add-tenant` prints (`AS_TRACKER_API_URL`,
`AS_TRACKER_KEY`). Four ways to get those two values + the script tag onto
a page, roughly in order of "how much can this client edit themselves":

1. **Manual `<script>` tag** — paste the block from `add-tenant`'s "1.
   WEBSITE" output directly before `</body>` (or in a theme's header/footer
   include). Works everywhere, needs FTP/theme-editor access.
2. **Google Tag Manager, Custom HTML tag** — `gtm/custom-html-tag.html`.
   The same block pasted into GTM's built-in Custom HTML tag type instead
   of the site's template. No import, no review — this is the default
   recommendation for any client already running GTM.
3. **Google Tag Manager, Custom Template** — `gtm/automated-sales-tracker.tpl`.
   A proper GTM tag type with two labeled fields instead of raw HTML,
   nicer for a client's marketing team to self-serve. **Unverified against
   a live GTM container** — built correctly against Google's documented
   Sandboxed JS API and permissions format (see the file's `___NOTES___`
   section for exactly what was checked against what), but not
   import-tested. Falls back to option 2 if anything doesn't import cleanly.
4. **WordPress plugin** — `wordpress-plugin/automated-sales-tracker.zip`.
   Upload via Plugins → Add New → Upload Plugin, activate, paste the same
   three values into Settings → Automated Sales Tracker. For clients on
   WordPress who don't already use GTM. Syntax-checked (`php -l`) and
   reviewed against the standard WordPress Settings API; not yet
   activated on a live WordPress install.

Whichever path, forms with a recognizable email field (`type="email"`, or
a name/id/placeholder containing "email") are identified automatically —
no extra code for most WordPress/Webflow/plain-HTML forms. Anything that
doesn't fire a native form submit event (Calendly, Typeform, a custom JS
widget) needs one manual call on success: `window.ASTracker.identify(email)`.

## Two delivery modes — layer both, or start with one

**Native custom fields (no Pipedrive app of any kind).** The backend
writes first-touch/last-touch channel, source, campaign, and a plain-text
journey log directly onto that client's own Pipedrive Person and Deal
fields, using nothing but their API token. No Developer Hub registration,
no install step, no review of any kind — because it isn't an "app" as far
as Pipedrive is concerned, just normal API writes anyone with API access
can already make. The payoff is bigger than "avoids review," though:
because these are real Pipedrive fields, that client can filter deal
lists by "First Touch Channel," add it as a column, or build an Insights
report segmented by it — none of which a custom UI panel can do, since a
panel is just a visual overlay Pipedrive can't query against.

**Custom UI panel (private app, registered per client).** A richer
visual timeline embedded directly on the Person/Deal detail page. This
does register as an "app" in that client's Pipedrive Developer Hub, but
as a **private app** — Pipedrive's docs are explicit that private apps
"bypass the standard [marketplace] approval process entirely" and install
to that account immediately; the review/approval wait only applies to
*public* apps listed for arbitrary companies to discover and install. So
the "avoid the long approval wait" goal is already satisfied by building
it as a private app — the custom-fields path isn't needed instead of the
panel for that reason. It's still worth having both: fields are what a
client's reports and filters can use; the panel is the nicer one-glance
read for a rep sitting on the record.

Ship the fields first for a new client (a token and one script) and add
the panel whenever you're ready — they're independent and don't conflict.

## Self-serve portal — `/attribution`

A third way in, alongside the CLI (`add-tenant`, for you to onboard a
client) and the two Pipedrive-side delivery modes above (for what a rep
sees once onboarded): a public, branded front door where a client
onboards *themselves*, plus a dashboard they can log into afterward.

- **`/attribution`** — marketing/landing page explaining the product.
- **`/attribution/signup`** — company name, work email, a password, and
  their Pipedrive API token (found under Personal Preferences → API in
  their own Pipedrive account). The token is verified live against
  Pipedrive on submit (same call `add-tenant`'s operator would eyeball
  manually — see `getMe` in `server/src/lib/pipedrive.ts`), then the
  tenant is created and its custom fields are set up automatically —
  the exact same logic `npm run setup:pipedrive` runs, just triggered
  automatically instead of needing that command run by hand.
- **`/attribution/login`** and **`/attribution/dashboard`** — email +
  password login (a session cookie, not the trackKey/webhookSecret
  scheme the tracking snippet and webhooks use — see
  `server/src/lib/auth.ts`), then an aggregated view across *all* of that
  tenant's contacts: channel breakdown, top campaigns, recently active
  prospects. This is the one place in the whole project that shows
  cross-contact data — the Pipedrive panel is deliberately scoped to one
  record at a time.

**Why not Pipedrive OAuth instead of pasting an API token?** Considered
first, but dropped in favor of the simpler token-paste flow: no Pipedrive
Developer Hub app to register, no client ID/secret to configure, nothing
that needs Pipedrive's involvement at all before this can go live. If
self-serve volume ever grows enough that "paste your own API token" feels
like too much friction, OAuth is the natural next step — confirmed via
Pipedrive's docs that a **private app switched to "Live" status can be
installed via OAuth by any company, with no marketplace review**, so it
wouldn't reopen the approval-wait problem this project already avoids
elsewhere. The exact OAuth endpoints/flow (authorize URL, token exchange,
refresh tokens, the `/users/me` call to identify the connecting company)
were researched and verified against Pipedrive's docs during this
project's design, so that groundwork isn't lost if this is picked up
later — it just isn't implemented, since the simpler path covers today's
need.

**No dedicated frontend framework** — the portal is four static HTML
files (`server/public/attribution/`) with vanilla JS calling the backend
directly, not a React/Vite app like `panel/`. Deliberate: the panel needs
React because it's embedded in a Pipedrive iframe via
`@pipedrive/app-extensions-sdk`; the portal doesn't have that constraint,
so a build step would just be overhead for four forms and some bar charts
built out of styled `<div>`s.

Branding note: colors/fonts are a best-effort match to
automated-sales.com from screenshots, not extracted hex codes — see
`server/public/attribution/style.css`'s CSS variables at the top if you
want to swap in exact values or a logo file.

## Contact-level or deal-level? Both — but they mean different things

The full, ever-growing touchpoint history lives on the **Person**
(Contact). That's the right home for it: an identity is a human, and
`server/src/lib/identity.ts` resolves every anonymous cookie ID, email,
and Pipedrive Person ID down to one Identity row — a Deal doesn't have
its own separate journey, it's just one chapter in the person's. The
Person-level fields (`AS: First Touch Channel`, `AS: Last Touch Channel`,
`AS: Journey Summary`, etc.) are **living** — they update every time a
new touchpoint comes in, for as long as that person is active.

Each **Deal** additionally gets its own small set of fields
(`AS: First Touch Channel (at deal creation)`, `AS: Touchpoints Before
Deal Created`, `AS: Days From First Touch To Deal Created`) that are
**frozen the moment the deal is created** and never change after. This
matters the instant a contact has more than one deal over time: without
freezing, a repeat customer's brand-new deal would show whatever the
Person's *current* first/last touch happens to be, which might be a
totally different (and irrelevant) touchpoint from years earlier or from
an unrelated later campaign. The frozen deal-level snapshot answers "what
caused *this* deal specifically" — what you actually want when
segmenting deals by source in a pipeline report — while the Person-level
fields answer "what's this human's whole relationship with us looked
like so far."

Short version: **living history on the Contact, frozen attribution
snapshot on each Deal.** Both are built.

## How it works

```
Client A's website + ads   ─┐
Client A's email tool      ─┼─▶  /t/acme-co/...   ─┐
Client A's Pipedrive       ─┘                       │
                                                      ├─▶  One backend (server/) ─┬─▶ Pipedrive custom fields (per tenant)
Client B's website + ads   ─┐                       │                            └─▶ Shared panel (panel/, ?tenant=slug)
Client B's email tool      ─┼─▶  /t/other-co/...   ─┘
Client B's Pipedrive       ─┘
```

- **`server/`** — Node/TypeScript/Express API. Every route is mounted
  under `/t/:tenant/...`; `routes/tenant-middleware.ts` resolves the slug
  to a `Tenant` row (Pipedrive token, webhook secret, track key, field
  maps) before any handler runs. Ingests touchpoints from four sources,
  resolves them onto one "Identity" per real prospect *within that
  tenant*, and both serves the merged timeline (for the panel) and syncs
  a computed summary onto that tenant's own Pipedrive custom fields.
- **`panel/`** — React app, one shared deployment, that Pipedrive iframes
  directly into the Person and Deal detail pages of *any* onboarded
  client's account; reads `?tenant=<slug>` off its own iframe URL to know
  whose data to call the API for.
- **`server/public/automated-sales-tracker.js`** — one JS file, hosted
  centrally and shared by every client, that captures pageviews, UTM
  parameters, ad click IDs (gclid, li_fat_id, msclkid), and auto-identifies
  visitors from form-email submits. Configured per client via two
  `window` variables (API URL + track key), not by editing the file.
- **`gtm/`** and **`wordpress-plugin/`** — four ways to get that snippet
  and its two config values onto a client's actual pages without editing
  their site's template code; see "Installing the snippet" above.
- **`pipedrive-app/`** — instructions + a reference checklist for
  registering the panel in a client's Pipedrive Developer Hub (only
  needed for the panel path, not the custom fields, and done once per
  client).
- **`server/public/attribution/`** — the self-serve portal (marketing
  page, signup, login, aggregated dashboard), served by the same backend
  process at `/attribution`; see "Self-serve portal" above.

### What's been verified vs. what needs a live account

Verified in this session: the identity-resolution logic and the full API
(`/api/track`, `/api/identify`, the Pipedrive webhook handler, and the
journey read endpoints) were run end-to-end against a simulated version
of the exact LinkedIn-ad → blog → direct-signup → deal-won journey, for
two separate tenants sharing the same email address, confirming both
that the journey survives intact and that tenant isolation actually
holds (not just assumed) — run `npm run smoke-test` in `server/` to see
it. The attribution-summary logic that feeds the custom fields (first/
last touch computation, the deal-creation "freeze" cutoff, and the
payload shape sent to Pipedrive) was verified the same way — run
`npm run verify-attribution`. The full multi-tenant HTTP surface (track
with a correct/incorrect key, an unknown tenant, identify, a Pipedrive
webhook with a correct/incorrect secret, and a journey read) was
exercised directly against a running server with curl during this build.
The panel builds and type-checks cleanly against Pipedrive's current
`@pipedrive/app-extensions-sdk` (v0.16.0), confirmed against that
package's actual shipped types rather than assumed.

**Not yet verified, because it needs a live Pipedrive account:** the
exact request/response shape for *creating* custom fields
(`npm run setup:pipedrive`, in `server/src/lib/pipedrive.ts`). Pipedrive's
field-management API is the one part of this whole build that could only
be confirmed from documentation, not a live test — the docs on this
point were less consistent than everywhere else checked. If
`npm run setup:pipedrive` errors, it prints Pipedrive's raw response;
share that and it's a quick fix. Reading and writing field *values* (v2
`custom_fields` PATCH format) is solid — that's a stable, current part of
the API confirmed directly.

**Also verified this session:** the tracking snippet's auto-identify
feature (matching an email field in a submitted form and calling
`identify()`) was tested directly with Playwright against several
realistic field-naming patterns, a no-email negative case, and a
double-submit de-dupe case. The centrally-hosted snippet's static-file
serving (`server/public/`, `express.static`) was confirmed with a running
server and curl. The WordPress plugin was syntax-checked (`php -l`,
clean) and reviewed against the standard WordPress Settings API, but not
activated against a live WordPress install (no outbound access to
Packagist in this environment to pull a WP-CLI test harness). **The GTM
Custom Template (`gtm/automated-sales-tracker.tpl`) is the least-verified
piece in this whole build:** its JS body and `___WEB_PERMISSIONS___` JSON
were built against Google's documented Sandboxed JS API and cross-checked
against real, working community `.tpl` files on GitHub (not just the
docs), but it has never been imported into a live GTM container. The GTM
Custom HTML tag (`gtm/custom-html-tag.html`) has no such risk — it's
just the same plain `<script>` block GTM's Custom HTML tag type already
knows how to run.

**Also verified this session, the self-serve portal:** password hashing/
verification (Node's built-in `crypto.scrypt` — chosen specifically to
avoid another native-binary dependency after Prisma and better-sqlite3
both failed to install in this sandbox), signup form validation, tenant
auto-provisioning (slug generation, collision handling, duplicate-email
rejection), session create/lookup/expiry/delete, and the dashboard's
aggregate-summary computation are all covered by `npm run verify-portal`
(pure logic, no network). The full login → session cookie → `/me` →
`/summary` → logout → session-actually-invalidated cycle was run against
a real running server with real HTTP requests (not mocked) — see
`npm run verify-portal-http:seed` / `:run` / `:cleanup` in
`server/src/verify-portal-http.ts`. **Not verified:** the signup route's
live call to Pipedrive (`getMe`, which validates the pasted API token) —
this sandbox has no outbound network path to `api.pipedrive.com` (a
direct `curl` to it from here gets connection-reset, confirmed directly),
so that one HTTP call is unverified here in the same way
`setup:pipedrive` already was — same underlying gap, now touched by two
code paths instead of one. Try a real signup against a real Pipedrive
account before pointing a client at it.

**Known limitation worth knowing before you scale this up:** the
database (`sql.js`, see below) is a single file loaded fully into memory
per process. Two server processes pointed at the same `DATABASE_PATH`
file will each hold a stale in-memory copy of anything the other writes
— confirmed directly while testing this build, not theoretical. Run
`add-tenant` / `setup:pipedrive` while the server process is stopped (or
restart the server after), and don't run more than one server instance
against the same file. Fine for a handful of clients on a single small
host; if you outgrow that (more write volume, need for multiple server
instances), swap `server/src/db.ts` for a Postgres-backed implementation
of the same interface — everything else in the app is unaffected.

## What you need from each client before they go live

1. **A Pipedrive API token** (Settings → Personal preferences → API in
   their account) and their company domain. Pass both to `add-tenant`, or
   add later and re-run `npm run setup:pipedrive -- --tenant <slug>`.
2. *(Panel only)* **5 minutes in their Pipedrive Developer Hub** to
   register the panel as a private app — see `pipedrive-app/README.md`.
3. **Which email tool they use** (Mailchimp / ActiveCampaign / HubSpot /
   Klaviyo / other) — the `/webhooks/email` mapping block in
   `server/src/routes/webhooks.ts` needs one adjustment per new ESP.
4. **How they want ad-click-to-conversion tied together, if at all** —
   LinkedIn Ads and Google Ads don't push "this person clicked" events
   with an email attached in real time. The tracking snippet already
   captures the click ID (`li_fat_id` / `gclid`) the moment someone lands
   on their site; a nightly job pulling each platform's offline
   conversion report (or a Zapier/Make automation) can post the resulting
   match to `/t/<slug>/webhooks/ads`. That scheduled job isn't built,
   since it depends on which ad accounts and reporting access a given
   client wants to use — build it once there's a concrete client asking.

Hosting the server and panel is a one-time cost across all clients, not
per-client — see Deploying below.

## Local setup (to try it yourself first)

```bash
cd server
cp .env.example .env
npm install
npm run smoke-test          # simulates two tenants' journeys end-to-end, proves isolation, no Pipedrive needed
npm run verify-attribution  # checks the custom-fields sync logic, also no Pipedrive needed
npm run verify-portal       # checks the self-serve portal's auth/signup/dashboard logic, also no Pipedrive needed
npm run add-tenant -- --slug test-co --name "Test Co"   # create a local test tenant
npm run dev                 # starts the API on :8787 — visit :8787/attribution for the portal

cd ../panel
npm install
npm run dev                # starts the panel on :5173 — open it with ?tenant=test-co
```

To exercise the portal's login/session flow against a real running
server (rather than just the pure logic above), see `server/src/
verify-portal-http.ts`'s three-step `--seed` / `--run` / `--cleanup` —
split that way because of the single-process database constraint below.

## Deploying

1. **Backend** (`server/`): `npm run build && npm start`, or deploy the
   folder as-is to Render/Railway/Fly (they all auto-detect a Node app —
   set the start command to `npm run build && npm start`). Only
   `DATABASE_PATH` and `PORT` are global env vars now (see
   `.env.example`) — everything client-specific lives in the `tenants`
   table, created via `npm run add-tenant`. The database is a single
   SQLite file (via sql.js — pure WASM, no native build step, so it
   installs reliably on any host); see the known limitation above about
   running exactly one server process against it.
   The `/attribution` self-serve portal is served by this same process
   (`server/public/attribution/`) — nothing extra to deploy for it.
2. **Panel** (`panel/`, optional, one deployment for every client):
   `VITE_API_BASE_URL=https://your-api-host npm run build`, then deploy
   `panel/dist` as a static site.
3. **Per new client**: `npm run add-tenant`, then follow the printed
   checklist (website snippet, LinkedIn toggle, email webhook, Pipedrive
   webhook, `setup:pipedrive`, and optionally `pipedrive-app/README.md`
   for the panel). Or skip this entirely for clients who sign up
   themselves through `/attribution/signup`.

See **`DIGITALOCEAN.md`** for a full step-by-step Droplet deployment
(Node + pm2 + Caddy for automatic TLS, plus how to reconcile "hosted at
automated-sales.co/attribution" with the main site living elsewhere).

## Data model

- **Tenant** — one row per client business: Pipedrive API token and
  company domain, a webhook secret shared by that tenant's Pipedrive/
  email/ads webhook URLs, a track key for their website snippet, their
  synced Pipedrive custom-field key maps (Person + Deal), and — for
  self-serve signups only — a login email + hashed password and
  `signupSource` ('cli' or 'self_serve').
- **Session** — one row per logged-in portal session: an opaque token
  (the value stored in the `/attribution` login cookie), the tenant it
  belongs to, and an expiry. Only used by the portal login — has nothing
  to do with the trackKey/webhookSecret scheme the tracking snippet and
  webhooks use (see `server/src/routes/tenant-middleware.ts` for that
  separate, machine-to-machine auth model).
- **Identity** — one row per real prospect, scoped to one tenant. Keyed
  by `(tenantId, email)` and `(tenantId, pipedrivePersonId)`, plus a list
  of merged anonymous cookie IDs, so all of the above can point at the
  same person even if they show up under different handles first.
- **Touchpoint** — one row per event, scoped to one tenant: an ad click,
  a page visit, an email open, a stage change, etc. Always linked to an
  Identity, ordered by `occurredAt` for the timeline.
- **Pipedrive custom fields** — a derived, synced *view* of the above per
  tenant, not a separate source of truth: `AS: First Touch Channel` etc.
  on Person (living), `AS: First Touch Channel (at deal creation)` etc.
  on Deal (frozen). See `server/src/lib/attribution.ts` and
  `server/src/lib/pipedrive-fields.ts`.

Full schema and identity-resolution logic:
`server/src/db.ts` and `server/src/lib/identity.ts` (the latter has
inline comments explaining the merge order and why).

## What's deliberately out of scope for this first version

- **Weighted attribution modeling** (assigning fractional "credit" across
  touchpoints) — this tool shows the full path and a simple first-touch/
  last-touch summary; deciding how much credit each step gets beyond
  that is a judgment call worth making with real data in hand, not baked
  into the tool.
- **Ad platform API polling** (see point 4 above) — needs a specific
  client's ad account access to wire up.
- **Portal password reset** — a client who forgets their `/attribution`
  login password today needs you to reset it directly in the `tenants`
  table (there's no "forgot password" email flow). Worth adding once
  self-serve volume makes "email me" an unreasonable ask.
- **Portal OAuth-based login/signup** — see "Self-serve portal" above for
  why token-paste was shipped instead, and what's already verified if you
  want to build OAuth in later.
- **A hosted, always-on deployment** — this was built and verified in a
  sandbox session, but actually running it live needs real hosting —
  see `DIGITALOCEAN.md`.
