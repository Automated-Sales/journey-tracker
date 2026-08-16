/**
 * One-off diagnostic: fetches a Person straight from Pipedrive's live API
 * and prints it next to what our stored field map expects, so we can see
 * exactly whether a sync actually landed values in the right place —
 * without relying on the Pipedrive UI, which can hide custom fields that
 * exist but aren't added to a Person's visible layout.
 *
 * Run with: npx ts-node src/debug-person.ts --tenant <slug> --person <id>
 * Read-only — safe to run alongside the live server, no need to stop pm2.
 */
import "dotenv/config";
import { db } from "./db";
import { getPerson } from "./lib/pipedrive";

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
    console.error("Usage: npx ts-node src/debug-person.ts --tenant <slug> --person <id>");
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

  console.log(`Field map stored on tenant "${tenant.id}":`);
  console.log("  person:", JSON.stringify(tenant.personFieldMap, null, 2));
  console.log("  deal:  ", JSON.stringify(tenant.dealFieldMap, null, 2));
  console.log("  pipedriveVisitLogging:", JSON.stringify(tenant.pipedriveVisitLogging));

  console.log(`\nFetching Person ${args.person} live from Pipedrive...`);
  const person = await getPerson(tenant.pipedriveApiToken, Number(args.person));

  console.log("\nFull live Person record:");
  console.log(JSON.stringify(person, null, 2));

  if (tenant.personFieldMap) {
    console.log("\n--- Cross-check: what our sync expects to find ---");
    const liveCustomFields = (person as any)?.custom_fields || {};
    for (const [localKey, fieldKey] of Object.entries(tenant.personFieldMap)) {
      const liveValue = liveCustomFields[fieldKey as string];
      console.log(`  ${localKey}  (field key ${fieldKey}):  ${JSON.stringify(liveValue)}`);
    }
  }

  console.log(`\n--- Our own DB: identity linked to pipedrivePersonId ${args.person} ---`);
  const identity = await db.identity.findUnique({
    where: { tenantId: tenant.id, pipedrivePersonId: Number(args.person) },
  });
  console.log(JSON.stringify(identity, null, 2));

  if (identity) {
    const touchpoints = await db.touchpoint.findMany({
      where: { tenantId: tenant.id, identityId: identity.id },
      orderBy: { occurredAt: "asc" },
    });
    console.log(`\nTouchpoints on that identity (${touchpoints.length}):`);
    touchpoints.forEach((tp) =>
      console.log(
        `  ${tp.occurredAt.toISOString()}  ${tp.channel}  source=${tp.source}  durationMs=${tp.durationMs}` +
          (tp.durationMs != null && tp.durationMs >= 3000 ? "  <- qualifies for visit logging (>=3000ms)" : "")
      )
    );
  } else {
    console.log("(No identity in our DB has this pipedrivePersonId set at all.)");
  }
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
