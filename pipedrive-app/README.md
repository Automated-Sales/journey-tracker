# Registering the panel as a Pipedrive app — per client

This is only needed for the **visual panel**. The custom-fields path
(see the root `README.md`) needs none of this — no app, no Developer Hub,
just that client's API token and `npm run setup:pipedrive -- --tenant <slug>`.
Steps 1–2 below are panel-only; step 3 (webhooks) is needed either way,
since both delivery modes depend on the backend hearing about Pipedrive
changes for that client.

**This is a per-client registration.** The panel deployment itself
(`panel/dist`) is built and hosted **once** and shared by every client —
one static site. What's per-client is the registration: each client has
their own separate Pipedrive account, so each needs their own private-app
entry in their own Developer Hub, pointing at the same panel URL with a
different `?tenant=<slug>` query param so the panel knows whose data to
load. Run `npm run add-tenant` first (see root README) — it prints the
exact iframe URL and webhook URL for whichever client you're setting up.

Pipedrive Custom UI Extensions are registered through the **Developer Hub**
UI, not a JSON file you upload — `app-manifest.json` in this folder is a
reference for exactly what to enter, not something Pipedrive consumes
directly.

One thing worth being explicit about: registering this as a **private**
app means it never enters Pipedrive's marketplace review queue at all —
that review process only applies to *public* apps you'd list for other
companies to discover and install. A private app installs to that
client's account the moment they click install, no wait, no approval. So
this isn't a slower fallback to the custom-fields path — it's just as
immediate, it's simply a separate registration step (done once per
client) that the fields-only path skips entirely.

## 1. Create the app (in this client's Pipedrive account)

1. Go to `https://<this-clients-company-domain>.pipedrive.com/developer-hub`.
   You'll need to do this from an account that's an admin on that
   client's Pipedrive — either their admin does it themselves following
   these steps, or they grant temporary access.
2. Click **Create an app** → **Private app**.
3. Name it "Prospect Journey" (or similar).

## 2. Add the Custom UI Extension

1. In the app's settings, open the **App Extensions** tab.
2. Click **Add extension** → **Custom UI extension**.
3. Set, for both a Person-detail and a Deal-detail placement (add one
   extension per placement — see `app-manifest.json` for both):
   - **Type**: Panel
   - **Iframe URL**: the shared panel deployment's URL with this
     client's tenant slug appended, e.g.
     `https://journey-panel.yourdomain.com/?tenant=acme-co`
     (exact URL is printed by `npm run add-tenant`)
   - **Panel name**: "Prospect Journey"
4. Save, then **install the app to this client's company** (private apps
   still need an explicit install step even for the account that created
   them).

The panel itself only needs building and deploying once, ever — not per
client:

```
VITE_API_BASE_URL=https://journey-api.yourdomain.com npm run build
```

(`panel/dist` is a static site — host it anywhere that serves static
files over HTTPS: Vercel, Netlify, Cloudflare Pages, S3+CloudFront.
Pipedrive requires the iframe URL to be HTTPS.)

## 3. Set up this client's Pipedrive → backend webhook

Also register a regular Pipedrive webhook (separate from the panel) in
this client's account, so the backend hears about new People, Deal
creation/stage changes, and Activities for them specifically:

1. Go to **Settings → Tools and apps → Webhooks** in this client's
   Pipedrive (or, for Developer Hub apps, the app's own **Webhooks** tab).
2. Event URL: use the exact URL `npm run add-tenant` printed for this
   client — it already has their tenant slug and their own generated
   secret baked in:
   `https://journey-api.yourdomain.com/t/<slug>/webhooks/pipedrive?secret=<that tenant's webhookSecret>`
3. Subscribe to: `person.create`, `person.change`, `deal.change`,
   `activity.create`, `note.create`.

See the root `README.md` for the full onboarding checklist for a new
client, including the website snippet, LinkedIn/email setup, and what you
need from the client before any of this goes live.
