/**
 * One-off repair: merges a specific Pipedrive-linked "orphan" identity
 * (one that got created with a pipedrivePersonId but no email, usually
 * from a deal/activity/note webhook racing ahead of the person webhook
 * for a brand-new contact — see routes/webhooks.ts's extractPersonEmail
 * doc comment and the mergeIdentities-first fix applied there) back into
 * the correct, already-identified record for the same person.
 *
 * This just calls the same mergeIdentities() the webhook handlers use —
 * it already knows how to find both candidates (by email and by
 * pipedrivePersonId), pick the earliest-created one as primary, re-point
 * every touchpoint from the other(s) onto it, and delete the duplicate
 * row. Then it immediately re-syncs the merged identity's full journey
 * to Pipedrive's custom fields, rather than waiting for the next webhook.
 *
 * Run with:
 *   npx ts-node src/reconcile-identity.ts --tenant <slug> --email <email> --person <id> [--deal <id>]
 *
 * Safe to run alongside the live server (writes through the same sql.js
 * db module the server uses, same as any other CLI script here).
 */
import "dotenv/config";
import { db } from "./db";
import { mergeIdentities } from "./lib/identity";
import { syncPersonAttribution } from "./lib/pipedrive-sync";

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
  if (!args.tenant || !args.email || !args.person) {
    console.error("Usage: npx ts-node src/reconcile-identity.ts --tenant <slug> --email <email> --person <id> [--deal <id>]");
    process.exit(1);
  }

  const tenant = await db.tenant.findById(args.tenant);
  if (!tenant) {
    console.error(`Unknown tenant "${args.tenant}".`);
    process.exit(1);
  }

  console.log(`Merging: email=${args.email}  pipedrivePersonId=${args.person}  pipedriveDealId=${args.deal ?? "(none)"}`);

  const merged = await mergeIdentities(tenant, {
    email: args.email,
    pipedrivePersonId: Number(args.person),
    pipedriveDealId: args.deal ? Number(args.deal) : undefined,
  });

  console.log("\nMerged identity:");
  console.log(JSON.stringify(merged, null, 2));

  const touchpoints = await db.touchpoint.findMany({
    where: { tenantId: tenant.id, identityId: merged.id },
    orderBy: { occurredAt: "asc" },
  });
  console.log(`\nTouchpoints now on this identity (${touchpoints.length}):`);
  touchpoints.forEach((tp) => console.log(`  ${tp.occurredAt.toISOString()}  ${tp.channel}  source=${tp.source}`));

  console.log("\nRe-syncing to Pipedrive...");
  await syncPersonAttribution(tenant, merged);
  console.log("Done — check pm2 logs for a [pipedrive-sync] error if this didn't work, otherwise it should now be live.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
