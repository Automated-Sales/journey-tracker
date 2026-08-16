# Deploying to DigitalOcean

Everything in this project — the tracking API, the tenant-scoped
tracking/webhook endpoints, the `/automated-sales-tracker.js` snippet, and
the self-serve portal (marketing page, signup, login, dashboard) — is one
Node.js process (`server/`) serving plain files and JSON. No database
server, no build step for most of it, nothing that needs anything more
than a small Droplet.

## One hard constraint first

**Run exactly one instance of this process.** The database
(`server/src/db.ts`, sql.js) loads the whole SQLite file into memory once
per process and only writes it back to disk on each change — a second
process (a second `pm2` instance, a load-balanced pair of Droplets, etc.)
pointed at the same `DATABASE_PATH` would hold a stale copy and silently
lose writes. Fine for a Pipedrive consultancy's client volume on one
small Droplet; if you ever outgrow that, swap `db.ts` for a Postgres
implementation of the same interface first (see the root README's "Known
limitation" section).

## 1. Create the Droplet

- **Ubuntu 24.04 LTS**, the cheapest tier that isn't the absolute smallest
  (1 GB RAM / 1 vCPU is enough to start; the whole app plus Node's runtime
  fits comfortably — bump to 2 GB if you're also running Caddy and other
  services on the same box). Region: closest to where most clients are.
- Add your SSH key during creation rather than a root password.

## 2. Install Node and clone the project

```bash
ssh root@your-droplet-ip

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git

git clone <your private repo url> journey-tracker
cd journey-tracker/server
npm install     # NOT --omit=dev — see note below
npm run build   # compiles TypeScript -> dist/
```

Use a full `npm install`, not `npm install --omit=dev`. It's tempting to
skip devDependencies on a production box, but this project's build step
(`tsc`) needs `typescript`, and its CLI scripts (`add-tenant`,
`list-tenants`, `setup:pipedrive`) run via `ts-node` at runtime too — so
devDependencies aren't just a build-time convenience here, `--omit=dev`
breaks both the build and every CLI script with `tsc: not found` /
`ts-node: not found`.

(If you're not using git, `scp -r` the project folder up instead — either
way, `server/` is the only directory that needs to actually run on the
Droplet; `gtm/`, `wordpress-plugin/`, `pipedrive-app/` are all take-away
files for clients, not things this server serves at runtime beyond the
one snippet file already under `server/public/`, plus the WordPress
plugin zip and any other downloads placed in `server/public/downloads/`
so the dashboard can link to them.)

## 3. Environment variables

Create `server/.env` (never commit this):

```bash
PORT=8787
DATABASE_PATH=/root/journey-tracker-data/tenants.db
NODE_ENV=production
PUBLIC_BASE_URL=https://your-subdomain.example.com
```

`PUBLIC_BASE_URL` is what the dashboard's "Install tracking" section uses
to build each client's exact tracking snippet/API URL — set it to
whatever domain you land on in step 5 below, once you know it.

Put `DATABASE_PATH` outside the git-cloned directory (e.g.
`/root/journey-tracker-data/`) so a future `git pull` / redeploy can't
ever touch it, and so it's obvious what to include in backups:

```bash
mkdir -p /root/journey-tracker-data
```

Three more variables (`STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`,
`STRIPE_WEBHOOK_SECRET`) enable billing for self-serve signups — leave
them unset for now if you're not ready to charge yet (CLI-onboarded
tenants work fine either way), and see step 7 below when you are.

## 4. Run it with pm2

```bash
npm install -g pm2
cd /path/to/journey-tracker/server
pm2 start dist/index.js --name journey-tracker --instances 1
pm2 startup   # prints a command to run once, so pm2 survives a reboot
pm2 save
```

`--instances 1` is deliberate — see the hard constraint above. pm2's
cluster mode (`-i max`) would silently violate it.

Onboard your first client the same way as in local dev, just run on the
Droplet:

```bash
npm run add-tenant -- --slug acme-co --name "Acme Co" \
  --pipedrive-token <token> --pipedrive-domain acme-co \
  --base-url https://journey-api.automated-sales.co
```

Stop the pm2 process before running `add-tenant` / `setup:pipedrive` /
any other one-off script, then start it again after — same single-process
caveat as above, since the CLI script and the running server would
otherwise each hold their own copy of the database in memory at once.

## 4.5 Redeploying updates (zip-based, no git)

If you're deploying via `scp`-ed zip files rather than `git pull`, **never
wholesale-delete the `server/` directory** as part of a redeploy —
`server/.env` lives inside that folder, and a fresh zip never contains it
(it's gitignored / left out on purpose, since it holds this Droplet's real
`DATABASE_PATH`, not a template value). Deleting and replacing the whole
folder silently drops `.env`, and the app then falls back to
`DATABASE_PATH=./dev.db` — a brand new, empty database sitting right next
to the real one — which looks like data loss (it isn't; the real file at
`/root/journey-tracker-data/tenants.db` is untouched) but breaks every
tenant-scoped route with 404 "Unknown tenant" until `.env` is restored.
(This happened once during development — see git history / conversation
log for the incident this section is written from.)

Safe procedure:

```bash
cd ~
cp journey-tracker/server/.env ~/server.env.backup   # 1. back up .env FIRST

rm -rf journey-tracker/server
unzip -o journeytracker.zip -d journey-tracker-new
mv journey-tracker-new/server journey-tracker/server
rm -rf journey-tracker-new

cp ~/server.env.backup journey-tracker/server/.env   # 2. restore it immediately

cd journey-tracker/server
npm install
npm run build
grep -c "PUBLIC_BASE_URL\|DATABASE_PATH" .env         # sanity check: should print 2
pm2 restart journey-tracker
```

Even better if you're doing this often: switch to `git pull` for
redeploys (step 2 already supports it) — a pull only touches
git-tracked files, so `.env` (gitignored) is never at risk.

## 5. Put a domain + TLS in front of it

**Caddy** is the least fuss here — it gets a free TLS certificate and
renews it automatically, with a two-line config:

```bash
apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```
journey-api.automated-sales.co {
  reverse_proxy localhost:8787
}
```

```bash
systemctl reload caddy
```

Point a DNS **A record** for `journey-api.automated-sales.co` (or
whatever subdomain you pick) at the Droplet's IP. Caddy issues the
certificate automatically the first time it sees traffic for that
hostname — no certbot, no manual renewal cron job.

## 6. Getting `automated-sales.co/attribution` to actually show this

The original brief was to host this at **automated-sales.co/attribution**
— but `automated-sales.co` is a Next.js app deployed on Vercel (source on
GitHub, auto-deploys on push to `main`), running on different
infrastructure than this Droplet. That's now settled in favor of the
simpler option: the portal lives entirely on its own dedicated subdomain,
**attribution.automated-sales.co**, at clean root paths (`/`, `/login`,
`/signup`, `/dashboard`, `/journey/:id`) — no `/attribution` prefix
repeating what the subdomain already says. `src/index.ts` also keeps
permanent redirects from the old `/attribution/*` paths, since links
already pushed into a client's Pipedrive (the "AS: View Journey" custom
field) have the old URL shape baked into them as plain saved text.

If you ever want `automated-sales.co/attribution` itself to redirect
through to the subdomain (rather than sending people straight to
`attribution.automated-sales.co`), add a `redirects()` rule in the
Next.js repo's `next.config.ts`:

```ts
async redirects() {
  return [
    { source: "/attribution", destination: "https://attribution.automated-sales.co", permanent: true },
    { source: "/attribution/:path*", destination: "https://attribution.automated-sales.co/:path*", permanent: true },
  ];
}
```

Merge that into whatever's already exported from `next.config.ts` rather
than replacing the file. Push to `main`, Vercel redeploys automatically.
The address bar will show the subdomain after that first hop, not the
exact `automated-sales.co/attribution` path — a path-matching reverse
proxy (keeping the URL bar on `automated-sales.co/attribution` exactly)
isn't an option anymore now that the two apps use different path shapes,
so a redirect is the only reasonable route if this is ever wanted.

## 7. Billing (Stripe)

Once the subdomain + TLS from step 5 is live (Stripe's webhook needs a
real HTTPS URL to call), wire up billing — see the README's "Billing"
section for what this actually gates and how.

1. In the Stripe Dashboard: **Product catalog** → create one Product
   (e.g. "Attribution — monthly") with one recurring monthly Price.
   Copy its `price_...` id.
2. **Developers > API keys** → copy the secret key (`sk_live_...` once
   you're ready to charge real cards; `sk_test_...` while you're still
   testing the flow end-to-end).
3. **Developers > Webhooks** → add an endpoint at
   `https://attribution.automated-sales.co/webhooks/stripe`, subscribed
   to `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, and `invoice.payment_failed`. Copy
   its signing secret (`whsec_...`).
4. Add all three to `server/.env` on the Droplet:
   ```bash
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_PRICE_ID=price_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
   then `pm2 restart journey-tracker --update-env` to pick them up (same
   as any other `.env` change — see step 4.5's redeploy notes for why
   `--update-env` matters here).
5. Do one real signup through `/signup` with a Stripe test card
   (`4242 4242 4242 4242`, any future expiry/CVC) before switching to
   live keys, and check the Stripe Dashboard's **Developers > Webhooks**
   log shows the events arriving with a 200 response — that's the
   webhook endpoint actually reachable from Stripe's side, not just
   configured.

CLI-onboarded tenants (`npm run add-tenant`) never need any of this —
see the README for why.

## 8. Backups

The entire database is the one file at `DATABASE_PATH`. A daily cron job
copying it somewhere durable is a complete backup strategy for this
project's current scale:

```bash
# /etc/cron.d/journey-tracker-backup
0 3 * * * root cp /root/journey-tracker-data/tenants.db /root/journey-tracker-data/backups/tenants-$(date +\%Y\%m\%d).db
```

(Prune old ones periodically, or push them to DigitalOcean Spaces /
S3 if you want off-Droplet backups.)

## About DigitalOcean App Platform instead

App Platform (git-push deploys, managed TLS, no SSH) is tempting for how
little there is to maintain, but its filesystem is **ephemeral on every
redeploy** — exactly wrong for a single-file SQLite database that needs
to persist. It would need App Platform's separate managed database
add-on, which means swapping `db.ts` for Postgres first (see the "Known
limitation" note in the root README) rather than something to bolt on
after the fact. A Droplet with a normal persistent disk, as above, is the
simpler match for how this project is built today.
