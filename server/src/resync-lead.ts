/**
 * One-off repair: retries pushing an already-frozen Lead attribution
 * snapshot to Pipedrive, without touching the freeze itself.
 *
 * Why this exists: freezeLeadAttribution (lib/pipedrive-sync.ts) sets
 * identity.leadCreatedAt/leadCreatedLeadId as a PERMANENT guard the
 * moment a Lead webhook first arrives — deliberately BEFORE attempting
 * the actual Pipedrive write, so the "this is the original source,
 * forever" timestamp reflects when the Lead was truly first seen, not
 * whenever some later retry happens to succeed. The downside: if that
 * Pipedrive write itself fails (a transient API error, a request-shape
 * bug like the one that prompted writing this script, rate limiting,
 * etc), the guard is already set, so the normal webhook path will never
 * retry it — every future Lead event for that identity is a no-op by
 * design (see freezeLeadAttribution's doc comment for why that's
 * correct behavior in the success case).
 *
 * This script re-attempts the SAME write using the timestamp and Lead id
 * already stored on the identity — it does not reset or recompute
 * anything, just retries the Pipedrive PATCH that failed the first time.
 *
 * Run with: npx ts-node src/resync-lead.ts --tenant <slug> --person <Pipedrive person id>
 * Safe to run against a live pm2 process.
 */
import "dotenv/config";
import { db } from "./db";
import { freezeLeadAttribution } from "./lib/pipedrive-sync";

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
  if (!args.tenant || !args.person) {
    console.error("Usage: npx ts-node src/resync-lead.ts --tenant <slug> --person <Pipedrive person id>");
    process.exit(1);
  }

  const tenant = await db.tenant.findById(args.tenant);
  if (!tenant) {
    console.error(`No tenant found with slug "${args.tenant}". Run \`npm run list-tenants\` to see valid slugs.`);
    process.exit(1);
  }

  const identity = await db.identity.findUnique({
    where: { tenantId: tenant.id, pipedrivePersonId: Number(args.person) },
  });
  if (!identity) {
    console.error(`No identity found for Pipedrive person ${args.person} on tenant "${args.tenant}".`);
    process.exit(1);
  }

  if (!identity.leadCreatedAt || !identity.leadCreatedLeadId) {
    console.error(
      `This identity has never been frozen (leadCreatedAt/leadCreatedLeadId are both null) — there's nothing to retry yet. That means either no Lead webhook has arrived for it, or this build predates the Lead attribution feature. Nothing to do here; the normal webhook path will freeze it the first time a real Lead event arrives.`
    );
    process.exit(1);
  }

  console.log(
    `Retrying the Pipedrive write for Lead ${identity.leadCreatedLeadId}, frozen at ${identity.leadCreatedAt.toISOString()} (this timestamp itself is NOT being changed — only the write to Pipedrive is being retried).`
  );

  await freezeLeadAttribution(tenant, {
    leadId: identity.leadCreatedLeadId,
    pipedrivePersonId: identity.pipedrivePersonId!,
    leadCreatedAt: identity.leadCreatedAt,
  });

  console.log("\nDone. Check pm2 logs for a fresh error if it failed again, or refresh the Lead in Pipedrive to confirm.");
}

main()
  .catch((err) => {
    console.error("resync-lead failed:", err.message || err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
