/**
 * Onboards a new client business as a tenant. Run once per client:
 *
 *   npm run add-tenant -- --slug acme-co --name "Acme Co" \
 *     --pipedrive-token <their Pipedrive API token> \
 *     --pipedrive-domain acme-co \
 *     --base-url https://journey-api.yourdomain.com
 *
 * --pipedrive-token/--pipedrive-domain can be added later by re-running
 * with the same --slug (see `npm run set-tenant-token`, or just edit the
 * tenants table directly for now) if the client isn't ready to hand over
 * their token yet — tracking and identify() will still work without it,
 * just not the Pipedrive-side sync.
 *
 * Prints everything needed to actually wire the client up: the tracking
 * snippet config block, the three webhook URLs, and the panel iframe URL
 * — hand this output to whoever installs the snippet on the client's site.
 */
import "dotenv/config";
import crypto from "crypto";
import { db } from "./db";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = value;
    }
  }
  return out;
}

function randomKey(bytes: number) {
  return crypto.randomBytes(bytes).toString("hex");
}

function isValidSlug(slug: string) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.slug || !args.name) {
    console.error("Usage: npm run add-tenant -- --slug acme-co --name \"Acme Co\" [--pipedrive-token ...] [--pipedrive-domain ...] [--base-url https://your-host]");
    process.exit(1);
  }
  if (!isValidSlug(args.slug)) {
    console.error(`"${args.slug}" isn't a valid slug — use lowercase letters, numbers, and hyphens only (e.g. "acme-co").`);
    process.exit(1);
  }

  const existing = await db.tenant.findById(args.slug);
  if (existing) {
    console.error(`Tenant "${args.slug}" already exists. Slugs must be unique; pick a different one, or edit the existing row directly if you need to update it.`);
    process.exit(1);
  }

  // signupSource defaults to "cli" here (unset), which db.tenant.create
  // maps to subscriptionStatus "exempt" — a tenant onboarded this way is
  // never billing-gated, regardless of Stripe being configured. That's
  // deliberate: the flat-fee Stripe subscription (see README "Billing")
  // is specifically the self-serve product's billing model. A client
  // onboarded by hand through this script is presumably billed some other
  // way (a consulting retainer, a one-off arrangement, etc.) — if you
  // ever want a CLI-onboarded tenant to actually go through Stripe too,
  // edit its subscriptionStatus column directly (or extend this script
  // with a --require-billing flag) rather than expecting it to happen
  // automatically.
  const tenant = await db.tenant.create({
    id: args.slug,
    name: args.name,
    pipedriveApiToken: args["pipedrive-token"] || null,
    pipedriveCompanyDomain: args["pipedrive-domain"] || null,
    trackKey: randomKey(16),
    webhookSecret: randomKey(16),
  });

  const baseUrl = args["base-url"] || `http://localhost:${process.env.PORT || 8787}`;

  console.log(`\nCreated tenant "${tenant.id}" (${tenant.name}).\n`);

  console.log("=".repeat(70));
  console.log("1. WEBSITE — add this to every page (see README \"Installing the");
  console.log("   snippet\" for GTM / WordPress-plugin alternatives to a raw <script> tag):");
  console.log("=".repeat(70));
  console.log(`
<script>
  window.AS_TRACKER_API_URL = "${baseUrl}/t/${tenant.id}";
  window.AS_TRACKER_KEY = "${tenant.trackKey}";
</script>
<script src="${baseUrl}/automated-sales-tracker.js"></script>

Forms with an email field are picked up automatically — no extra code
needed for most WordPress/Webflow/plain-HTML forms. For anything that
doesn't fire a native form submit event (Calendly, Typeform, a custom
JS widget), call this manually on a successful submission:
  window.ASTracker.identify(email)
`);

  console.log("=".repeat(70));
  console.log("2. LINKEDIN ADS — one-time toggle, no install:");
  console.log("=".repeat(70));
  console.log(`Campaign Manager > Account Settings > Insight Tag > check "Enable
enhanced conversion tracking". Google Ads needs nothing (auto-tagging is
on by default).\n`);

  console.log("=".repeat(70));
  console.log("3. EMAIL TOOL — paste this as a webhook URL for open/click/reply events:");
  console.log("=".repeat(70));
  console.log(`${baseUrl}/t/${tenant.id}/webhooks/email?secret=${tenant.webhookSecret}\n`);

  console.log("=".repeat(70));
  console.log("4. PIPEDRIVE WEBHOOK — Settings > Tools and apps > Webhooks:");
  console.log("=".repeat(70));
  console.log(`URL: ${baseUrl}/t/${tenant.id}/webhooks/pipedrive?secret=${tenant.webhookSecret}
Subscribe to: person.create, person.change, deal.change, activity.create, note.create,
lead.create, lead.change

(Lead events are needed for attribution to appear on a Lead before it's
converted to a Deal — added ${new Date().toISOString().slice(0, 10)}. In Pipedrive's
webhook UI this may show as ticking "Lead" under Event objects rather
than typing an event name directly; unverified against a live account,
see webhooks.ts's "lead" entity handler doc comment if it doesn't fire.)\n`);

  if (tenant.pipedriveApiToken) {
    console.log("=".repeat(70));
    console.log("5. NEXT: create this tenant's Pipedrive custom fields:");
    console.log("=".repeat(70));
    console.log(
      `pm2 stop journey-tracker\nnpm run setup:pipedrive -- --tenant ${tenant.id}\npm2 start journey-tracker\n\n(the pm2 stop/start matters — see setup-pipedrive-fields.ts's doc comment)\n`
    );
  } else {
    console.log("=".repeat(70));
    console.log("5. STILL NEEDED: this tenant has no Pipedrive API token yet.");
    console.log("=".repeat(70));
    console.log(`Once you have it, add --pipedrive-token/--pipedrive-domain (edit the
tenants table, or delete and re-run add-tenant), then:
  pm2 stop journey-tracker
  npm run setup:pipedrive -- --tenant ${tenant.id}
  pm2 start journey-tracker\n`);
  }

  console.log("=".repeat(70));
  console.log("6. OPTIONAL — panel (Custom UI Extension) iframe URL for this tenant:");
  console.log("=".repeat(70));
  console.log(`https://your-deployed-panel.example.com/?tenant=${tenant.id}
See pipedrive-app/README.md to register it in this client's Developer Hub.\n`);
}

main().catch((err) => {
  console.error("add-tenant failed:", err.message || err);
  process.exit(1);
});
