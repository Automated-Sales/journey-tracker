/**
 * Manually grants or changes a tenant's billing status — the tool for
 * "give this client free access" (subscriptionStatus 'exempt'), or for
 * fixing a tenant stuck in the wrong state by hand rather than through
 * Stripe. Run:
 *
 *   npm run set-tenant-billing -- --tenant acme-co --status exempt
 *
 * Most common use: a self-serve tenant that signed up before billing
 * existed (or anyone you want to comp) is currently gated because it
 * defaults to 'incomplete' — see db.ts's rowToTenant. Set it to 'exempt'
 * and the dashboard's requireActiveBilling (routes/portal.ts) treats it
 * exactly like a CLI-onboarded tenant: never billing-gated, regardless of
 * whether Stripe is even configured.
 *
 * Valid --status values: exempt, trialing, active, incomplete, past_due,
 * canceled — see db.ts's Tenant.subscriptionStatus and lib/stripe.ts's
 * isBillingActive for what each one does. Setting anything other than
 * 'exempt' by hand (e.g. forcing 'active' without a real Stripe
 * subscription) works for unlocking the dashboard, but note this tool
 * does NOT touch Stripe itself — it only writes this app's own copy of
 * the status. If Stripe's webhook later reports a real status for that
 * tenant (e.g. they eventually do go through Checkout), it will
 * overwrite whatever you set here, same as it would for any tenant.
 *
 * Same single-process caution as add-tenant.ts/setup:pipedrive: stop pm2
 * before running this, then start it again after, so this script's write
 * and the live server's in-memory copy of the DB can't clobber each
 * other on the next persist() —
 *   pm2 stop journey-tracker
 *   npm run set-tenant-billing -- --tenant acme-co --status exempt
 *   pm2 start journey-tracker
 */
import "dotenv/config";
import { db, Tenant } from "./db";

const VALID_STATUSES: Tenant["subscriptionStatus"][] = [
  "exempt",
  "trialing",
  "active",
  "incomplete",
  "past_due",
  "canceled",
];

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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.tenant || !args.status) {
    console.error("Usage: npm run set-tenant-billing -- --tenant <slug> --status <status>");
    console.error(`Valid statuses: ${VALID_STATUSES.join(", ")}`);
    process.exit(1);
  }

  if (!VALID_STATUSES.includes(args.status as Tenant["subscriptionStatus"])) {
    console.error(`"${args.status}" isn't a valid status. Valid statuses: ${VALID_STATUSES.join(", ")}`);
    process.exit(1);
  }

  const tenant = await db.tenant.findById(args.tenant);
  if (!tenant) {
    console.error(`No tenant found with slug "${args.tenant}". Run \`npm run list-tenants\` to see valid slugs.`);
    process.exit(1);
  }

  console.log(`"${tenant.name}" (${tenant.id}) — subscriptionStatus: ${tenant.subscriptionStatus} -> ${args.status}`);

  await db.tenant.updateBilling(tenant.id, {
    subscriptionStatus: args.status as Tenant["subscriptionStatus"],
  });

  console.log(`\nDone. Restart pm2 (\`pm2 start journey-tracker\` if you stopped it) — that tenant's dashboard will reflect this immediately on next load.`);
}

main()
  .catch((err) => {
    console.error("set-tenant-billing failed:", err.message || err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
