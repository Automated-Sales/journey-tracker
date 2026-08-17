/**
 * One-off repair: recovers the real Pipedrive activity type (call,
 * meeting, task, or a custom type like "whatsapp_chat") as the `source`
 * field on every EXISTING pipedrive_activity touchpoint, for tenants
 * onboarded before webhooks.ts's activity handler started capturing
 * this (it used to hardcode source: "pipedrive" for every activity
 * regardless of type — see that handler's doc comment for the fix).
 * Every activity touchpoint going forward already gets this correctly
 * at creation time; this is purely for data written before that fix.
 *
 * No live Pipedrive API call needed — the activity type was already
 * captured in the touchpoint's title (format: "{type} completed:
 * {subject}"), just not as a separate structured field. This just
 * re-parses what's already stored.
 *
 * Only touches touchpoints where channel="pipedrive_activity" AND
 * source="pipedrive" (the old hardcoded value) — running this twice, or
 * against touchpoints already fixed by the live webhook path, is a
 * harmless no-op. Titles that don't match the expected pattern (or whose
 * recovered "type" is the literal fallback word "Activity", meaning
 * Pipedrive genuinely sent no type for that event) are left alone —
 * there's nothing real to recover for those.
 *
 * Run with:
 *   pm2 stop journey-tracker
 *   npx ts-node src/backfill-activity-source.ts --tenant <slug>
 *   pm2 start journey-tracker
 * (the pm2 stop/start matters — see setup-pipedrive-fields.ts's doc
 * comment for why writing to the shared sql.js DB file while the live
 * server is also running risks one process's next persist() silently
 * overwriting the other's changes)
 */
import "dotenv/config";
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

const TITLE_PATTERN = /^(.+?) completed:/;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant) {
    console.error("Usage: npx ts-node src/backfill-activity-source.ts --tenant <slug>");
    process.exit(1);
  }

  const tenant = await db.tenant.findById(args.tenant);
  if (!tenant) {
    console.error(`No tenant found with slug "${args.tenant}". Run \`npm run list-tenants\` to see valid slugs.`);
    process.exit(1);
  }

  const touchpoints = await db.touchpoint.findManyByTenant({ where: { tenantId: tenant.id } });
  const candidates = touchpoints.filter((tp) => tp.channel === "pipedrive_activity" && tp.source === "pipedrive");

  console.log(`Found ${candidates.length} pipedrive_activity touchpoint(s) still on the old hardcoded "pipedrive" source.`);

  let updated = 0;
  let skipped = 0;
  for (const tp of candidates) {
    const match = tp.title ? tp.title.match(TITLE_PATTERN) : null;
    const recoveredType = match?.[1];
    if (!recoveredType || recoveredType === "Activity") {
      skipped++;
      continue;
    }
    await db.touchpoint.updateSource({ id: tp.id, tenantId: tenant.id, source: recoveredType });
    updated++;
  }

  console.log(`\nDone. Updated ${updated}, skipped ${skipped} (no recoverable type in their title — left as "pipedrive").`);
}

main()
  .catch((err) => {
    console.error("backfill-activity-source failed:", err.message || err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
