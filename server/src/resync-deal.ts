/**
 * One-off repair: force-pushes attribution custom fields onto a specific
 * Person + Deal right now, bypassing the normal "fires on the next
 * touchpoint/webhook" path. Also backfills the two deal-lifecycle
 * milestone counts (Lead→Deal, Deal→Won — see lib/deal-milestones.ts)
 * for deals that were created/won before that tracking existed, or
 * before this script itself covered them.
 *
 * Why this is needed: syncPersonAttribution runs after every touchpoint,
 * so a Person self-heals automatically once the tenant's field map is
 * fixed. freezeDealAttribution and the milestone writes, by design, only
 * run ONCE each — at deal-creation and deal-won time respectively (see
 * pipedrive-sync.ts and routes/webhooks.ts) — so a deal that went
 * through either transition before the relevant field/code existed never
 * gets a second chance without a manual nudge like this.
 *
 * Run with: npx ts-node src/resync-deal.ts --tenant <slug> --deal <id>
 * Safe to run against a live pm2 process — just re-runs the same sync
 * logic the app already runs, once, on demand. Idempotent: re-running
 * against a deal that's already fully synced just confirms and skips,
 * it won't reset or double-count anything (same dedup-by-stored-id guards
 * as the live webhook path).
 */
import "dotenv/config";
import { db } from "./db";
import { getDeal } from "./lib/pipedrive";
import { syncPersonAttribution, freezeDealAttribution, syncDealMilestoneField } from "./lib/pipedrive-sync";
import { countTouchpointsUpTo, countTouchpointsBetween } from "./lib/deal-milestones";

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

  const dealCreatedAt = new Date(deal.add_time);

  console.log("\nRe-running freezeDealAttribution (frozen-at-creation-time fields on the Deal)...");
  await freezeDealAttribution(tenant, {
    dealId: Number(args.deal),
    pipedrivePersonId: Number(personId),
    dealCreatedAt,
  });
  console.log("Done.");

  console.log("\nBackfilling deal-lifecycle milestones (Lead → Deal / Deal → Won touchpoint counts)...");
  const touchpoints = await db.touchpoint.findMany({
    where: { tenantId: tenant.id, identityId: identity.id },
    orderBy: { occurredAt: "asc" },
  });

  let current = identity;
  if (current.dealCreatedDealId !== Number(args.deal)) {
    const leadToDealTouchpoints = countTouchpointsUpTo(touchpoints, dealCreatedAt);
    current = await db.identity.setDealMilestone({
      where: { tenantId: tenant.id, id: current.id },
      data: { dealCreatedDealId: Number(args.deal), dealCreatedAt, leadToDealTouchpoints },
    });
    await syncDealMilestoneField(tenant, Number(args.deal), "deal_lead_to_deal_touchpoints", leadToDealTouchpoints);
    console.log(`  Lead → Deal: ${leadToDealTouchpoints} touchpoints (backfilled, pushed to Pipedrive)`);
  } else {
    console.log(`  Lead → Deal: already set (${current.leadToDealTouchpoints}) — left as-is.`);
  }

  if (deal.status !== "won") {
    console.log("  Deal → Won: this deal isn't marked Won yet — nothing to backfill.");
  } else if (current.wonDealId === Number(args.deal)) {
    console.log(`  Deal → Won: already set (${current.dealToWonTouchpoints}) — left as-is.`);
  } else {
    const wonAt = deal.won_time ? new Date(deal.won_time) : new Date();
    const dealToWonTouchpoints = countTouchpointsBetween(touchpoints, dealCreatedAt, wonAt);
    current = await db.identity.setDealMilestone({
      where: { tenantId: tenant.id, id: current.id },
      data: { wonDealId: Number(args.deal), dealToWonTouchpoints },
    });
    await syncDealMilestoneField(tenant, Number(args.deal), "deal_deal_to_won_touchpoints", dealToWonTouchpoints);
    console.log(`  Deal → Won: ${dealToWonTouchpoints} touchpoints (backfilled, pushed to Pipedrive)`);
  }

  console.log("\nAll done — refresh the Deal/Person page in Pipedrive to check.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
