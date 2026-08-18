/**
 * One-off diagnostic for the "Lead source fallback" feature — shows the
 * tenant's stored configuration (field key, label, cached options) and,
 * given a real Lead ID, the RAW value Pipedrive actually returns for
 * that field on that Lead. Built because the fallback is still not
 * firing even after fixing the string-only type check, and guessing a
 * fifth time isn't worth it — this shows real data instead.
 *
 * Run with:
 *   npx ts-node src/debug-lead-source-field.ts --tenant <slug> --lead <lead-uuid>
 * Read-only — safe to run alongside the live server, no need to stop pm2.
 *
 * The Lead ID is a UUID, visible in that Lead's own Pipedrive URL
 * (…/leads/inbox/<this-part>).
 */
import "dotenv/config";
import { db } from "./db";
import { getLead } from "./lib/pipedrive";

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
  if (!args.tenant) {
    console.error("Usage: npx ts-node src/debug-lead-source-field.ts --tenant <slug> --lead <lead-uuid>");
    process.exit(1);
  }

  const tenant = await db.tenant.findById(args.tenant);
  if (!tenant) {
    console.error(`Unknown tenant "${args.tenant}". Run npm run list-tenants to see what's onboarded.`);
    process.exit(1);
  }
  if (!tenant.pipedriveApiToken) {
    console.error(`Tenant "${tenant.id}" has no Pipedrive API token set.`);
    process.exit(1);
  }

  console.log("Stored lead-source-field config:");
  console.log("  leadSourceFieldKey:", tenant.leadSourceFieldKey);
  console.log("  leadSourceFieldLabel:", tenant.leadSourceFieldLabel);
  console.log("  leadSourceFieldOptions:", tenant.leadSourceFieldOptions);

  if (!tenant.leadSourceFieldKey) {
    console.log("\nNo lead-source field configured for this tenant — nothing to check.");
    return;
  }

  if (!args.lead) {
    console.log("\n(Pass --lead <lead-uuid> to also inspect a live Lead's raw value under this field key.)");
    return;
  }

  console.log(`\nFetching Lead ${args.lead} live to see the raw value stored under key "${tenant.leadSourceFieldKey}"...`);
  const lead: any = await getLead(tenant.pipedriveApiToken, args.lead);
  console.log("\nFull live Lead record:");
  console.log(JSON.stringify(lead, null, 2));
  console.log(`\nValue at lead["${tenant.leadSourceFieldKey}"]:`, JSON.stringify(lead?.[tenant.leadSourceFieldKey]));
}

main()
  .catch((err) => {
    console.error("\nFailed:", err.message || err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
