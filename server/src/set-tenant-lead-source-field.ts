/**
 * Sets (or clears) the per-tenant fallback lead-source field — see
 * db.ts's Tenant interface doc comment on leadSourceFieldKey for the
 * full reasoning. This is Stage 1's stand-in for what a proper settings
 * page (Stage 2, not yet built) will eventually do through the
 * dashboard itself.
 *
 * Takes a human-readable field NAME (e.g. "Social Form Source"), not the
 * raw Pipedrive field key (the long hash) — it looks up the tenant's
 * actual Lead/Deal field list live and matches by name, so you never
 * need to go find the raw key by hand. Leads and Deals share the same
 * custom-field definitions in Pipedrive (same reasoning as
 * setup-pipedrive-fields.ts's dealFieldMap being reused for Leads), so
 * this reads from /dealFields even though the field will actually be
 * read off Lead webhook payloads at runtime.
 *
 * Run:
 *   npm run set-tenant-lead-source-field -- --tenant johari-developers --field "Social Form Source"
 *
 * Clear it:
 *   npm run set-tenant-lead-source-field -- --tenant johari-developers --clear
 *
 * Same single-process caution as every other set-tenant-*.ts script —
 * stop pm2 before running this, then start it again after:
 *   pm2 stop journey-tracker
 *   npm run set-tenant-lead-source-field -- --tenant johari-developers --field "..."
 *   pm2 start journey-tracker
 */
import "dotenv/config";
import { db } from "./db";
import { listDealFields } from "./lib/pipedrive";

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
    console.error(
      'Usage: npm run set-tenant-lead-source-field -- --tenant <slug> --field "<exact Pipedrive field name>"\n   or: npm run set-tenant-lead-source-field -- --tenant <slug> --clear'
    );
    process.exit(1);
  }

  const tenant = await db.tenant.findById(args.tenant);
  if (!tenant) {
    console.error(`No tenant found with slug "${args.tenant}". Run \`npm run list-tenants\` to see valid slugs.`);
    process.exit(1);
  }

  if (args.clear) {
    await db.tenant.updateLeadSourceField(tenant.id, { leadSourceFieldKey: null, leadSourceFieldLabel: null });
    console.log(`Cleared the lead-source field mapping for "${tenant.name}" (${tenant.id}).`);
    return;
  }

  if (!args.field) {
    console.error('Provide --field "<exact Pipedrive field name>", or --clear to remove an existing mapping.');
    process.exit(1);
  }

  if (!tenant.pipedriveApiToken) {
    console.error(`Tenant "${args.tenant}" has no Pipedrive API token set — nothing to look the field up against.`);
    process.exit(1);
  }

  console.log(`Fetching this tenant's Lead/Deal fields from Pipedrive...`);
  const fields = await listDealFields(tenant.pipedriveApiToken);
  const wanted = args.field.trim().toLowerCase();
  const match = fields.find((f: any) => typeof f.name === "string" && f.name.trim().toLowerCase() === wanted);

  if (!match) {
    const close = fields.filter((f: any) => typeof f.name === "string" && f.name.toLowerCase().includes(wanted));
    console.error(`No field named exactly "${args.field}" found.`);
    if (close.length) {
      console.error(`\nDid you mean one of these?`);
      close.forEach((f: any) => console.error(`  - "${f.name}"`));
    } else {
      console.error(`\nAll available field names:`);
      fields.forEach((f: any) => console.error(`  - "${f.name}"`));
    }
    process.exit(1);
  }

  await db.tenant.updateLeadSourceField(tenant.id, { leadSourceFieldKey: match.key, leadSourceFieldLabel: match.name });
  console.log(
    `\nDone. "${tenant.name}" will now use "${match.name}" (field key ${match.key}) as the fallback first-touch source for any Lead whose contact has no other tracked touchpoints.`
  );
}

main()
  .catch((err) => {
    console.error("set-tenant-lead-source-field failed:", err.message || err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
