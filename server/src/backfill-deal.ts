/**
 * One-off: backfills the "frozen at deal creation" snapshot fields
 * (see lib/pipedrive-fields.ts DEAL_FIELDS) onto a Deal that was created
 * before the sync was correctly wired up — normally this only happens
 * automatically, once, at the moment a deal is first created (see the
 * "deal" handler in routes/webhooks.ts).
 *
 * Run with: npx ts-node src/backfill-deal.ts --tenant <slug> --deal <id> [--person <id>]
 * (--person is only needed if the live Deal record's person_id can't be
 * read for some reason — normally it's pulled straight from Pipedrive.)
 */
import "dotenv/config";
import { db } from "./db";
import { getDeal } from "./lib/pipedrive";
import { freezeDealAttribution } from "./lib/pipedrive-sync";

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
    console.error("Usage: npx ts-node src/backfill-deal.ts --tenant <slug> --deal <id> [--person <id>]");
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

  console.log(`Fetching Deal ${args.deal} live from Pipedrive...`);
  const deal: any = await getDeal(tenant.pipedriveApiToken, Number(args.deal));
  console.log("Full live Deal record:");
  console.log(JSON.stringify(deal, null, 2));

  const personId = args.person
    ? Number(args.person)
    : Number(deal?.person_id?.value ?? deal?.person_id?.id ?? deal?.person_id);

  if (!personId || Number.isNaN(personId)) {
    console.error("\nCould not determine a numeric person_id for this deal from the live record above — pass --person <id> explicitly.");
    process.exit(1);
  }

  const addTimeRaw = deal?.add_time ?? deal?.creation_time;
  const dealCreatedAt = addTimeRaw ? new Date(addTimeRaw) : new Date();

  console.log(`\nFreezing deal attribution: dealId=${args.deal}  personId=${personId}  createdAt=${dealCreatedAt.toISOString()}`);

  await freezeDealAttribution(tenant, {
    dealId: Number(args.deal),
    pipedrivePersonId: personId,
    dealCreatedAt,
  });

  console.log("\nDone — check pm2 logs for a [pipedrive-sync] error if this didn't work, otherwise the '(at deal creation)' fields should now be set on the Deal in Pipedrive.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
