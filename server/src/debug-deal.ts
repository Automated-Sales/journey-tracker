/**
 * One-off diagnostic: fetches a Deal live from Pipedrive, resolves its
 * linked Person, and runs the same cross-check debug-person.ts does —
 * saves a round trip when you only have the Deal ID handy (e.g. from the
 * Pipedrive URL) rather than the Person ID.
 *
 * Run with: npx ts-node src/debug-deal.ts --tenant <slug> --deal <id>
 * Read-only — safe to run alongside the live pm2 process.
 */
import "dotenv/config";
import { db } from "./db";
import { getDeal, getPerson } from "./lib/pipedrive";

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
  if (!args.tenant || !args.deal) {
    console.error("Usage: npx ts-node src/debug-deal.ts --tenant <slug> --deal <id>");
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

  console.log(`Fetching Deal ${args.deal} live from Pipedrive...`);
  const deal: any = await getDeal(tenant.pipedriveApiToken, Number(args.deal));
  console.log("\nFull live Deal record:");
  console.log(JSON.stringify(deal, null, 2));

  const personId = deal?.person_id?.value ?? deal?.person_id ?? null;
  if (!personId) {
    console.log("\nThis deal has no linked Person — nothing more to check.");
    return;
  }

  console.log(`\n--- Deal's linked Person is ${personId} ---`);

  console.log(`\nField map stored on tenant "${tenant.id}":`);
  console.log("  deal:  ", JSON.stringify(tenant.dealFieldMap, null, 2));
  console.log("  person:", JSON.stringify(tenant.personFieldMap, null, 2));

  console.log(`\nFetching Person ${personId} live from Pipedrive...`);
  const person: any = await getPerson(tenant.pipedriveApiToken, Number(personId));
  console.log("\nFull live Person record:");
  console.log(JSON.stringify(person, null, 2));

  console.log(`\n--- Our own DB: identity linked to pipedrivePersonId ${personId} ---`);
  const identity = await db.identity.findUnique({
    where: { tenantId: tenant.id, pipedrivePersonId: Number(personId) },
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
        `  ${tp.occurredAt.toISOString()}  ${tp.channel}  source=${tp.source}` +
          `  gclid=${tp.gclid}  fbclid=${tp.fbclid}  msclkid=${tp.msclkid}  referrer=${tp.referrer}  url=${tp.url}`
      )
    );
  } else {
    console.log("(No identity in our DB has this pipedrivePersonId set at all — the Person/Deal was created,");
    console.log(" but our webhook either hasn't fired yet or never matched it to any tracked identity.)");
  }

  console.log(`\n--- Our own DB: identity linked to pipedriveDealId ${args.deal} (via pipedriveDealIds) ---`);
  // Deal-linked-but-not-yet-Person-linked case: mergeIdentities stores the
  // deal ID on whichever identity it resolved via personId — if the person
  // link above came back empty, this searches by deal ID as a fallback so
  // we can tell "wrong identity" apart from "no identity at all."
  const allIdentities = await db.identity.findMany({ where: { tenantId: tenant.id } });
  const byDeal = allIdentities.filter((i) => i.pipedriveDealIds.split(",").includes(String(args.deal)));
  console.log(JSON.stringify(byDeal, null, 2));
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
