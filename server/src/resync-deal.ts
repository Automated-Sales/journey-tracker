/**
 * One-off repair: force-pushes attribution custom fields onto a specific
 * Person + Deal right now, bypassing the normal "fires on the next
 * touchpoint/webhook" path.
 *
 * Why this is needed: syncPersonAttribution runs after every touchpoint,
 * so a Person self-heals automatically once the tenant's field map is
 * fixed. freezeDealAttribution, by design, only runs ONCE — at the moment
 * a deal is created (see pipedrive-sync.ts) — so a deal created while the
 * tenant's field map was stale/incomplete never gets a second chance
 * without a manual nudge like this.
 *
 * Run with: npx ts-node src/resync-deal.ts --tenant <slug> --deal <id>
 * Safe to run against a live pm2 process — just re-runs the same sync
 * logic the app already runs, once, on demand.
 */
import "dotenv/config";
import { db } from "./db";
import { getDeal } from "./lib/pipedrive";
import { syncPersonAttribution, freezeDealAttribution } from "./lib/pipedrive-sync";

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
    console.error("Usage: npx ts-node src/resync-deal.ts --tenant <slug> --deal <id>");
    process.exit(1);
  }

  const tenant = await db.tenant.findById(args.tenant);
  if (!tenant) {
    console.error(`Unknown tenant "${args.tenant}".`);
    process.exit(1);
  }
  if (!tenant.pipedriveApiToken) {
    console.error(`Tenant "${tenant.id}" has no Pipedrive API token set.`);
    process.exit(1);
  }
  if (!tenant.personFieldMap || !tenant.dealFieldMap) {
    console.error(
      `Tenant "${tenant.id}" has no field map at all — run "npm run setup:pipedrive -- --tenant ${tenant.id}" first.`
    );
    process.exit(1);
  }

  console.log(`Fetching Deal ${args.deal} live from Pipedrive to find its linked Person + creation time...`);
  const deal: any = await getDeal(tenant.pipedriveApiToken, Number(args.deal));
  const personId = deal?.person_id?.value ?? deal?.person_id ?? null;
  if (!personId) {
    console.error("This deal has no linked Person — nothing to sync.");
    process.exit(1);
  }

  const identity = await db.identity.findUnique({
    where: { tenantId: tenant.id, pipedrivePersonId: Number(personId) },
  });
  if (!identity) {
    console.error(`No identity in our DB is linked to Pipedrive Person ${personId} — nothing to sync.`);
    process.exit(1);
  }

  console.log(`Found identity ${identity.id} (${identity.email ?? "no email"}), linked to Person ${personId}.`);

  console.log("\nRe-running syncPersonAttribution (living, full-history fields on the Person)...");
  await syncPersonAttribution(tenant, identity);
  console.log("Done.");

  console.log("\nRe-running freezeDealAttribution (frozen-at-creation-time fields on the Deal)...");
  await freezeDealAttribution(tenant, {
    dealId: Number(args.deal),
    pipedrivePersonId: Number(personId),
    dealCreatedAt: new Date(deal.add_time),
  });
  console.log("Done.");

  console.log("\nBoth pushed to Pipedrive — refresh the Deal/Person page there to check.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
