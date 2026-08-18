/**
 * Sets (or clears) the per-tenant fallback lead-source fields — see
 * db.ts's Tenant interface doc comment on leadSourceFields for the full
 * reasoning. This is Stage 1's stand-in for what a proper settings page
 * (Stage 2, built via routes/portal.ts's /api/settings/lead-source-field)
 * does through the dashboard itself.
 *
 * Takes one or more human-readable field NAMES (e.g. "Social Form
 * Source"), comma-separated, in PRIORITY ORDER — the first field with a
 * value on an incoming Lead/Deal webhook wins (see webhooks.ts's
 * applyLeadSourceFallback). Not the raw Pipedrive field key (the long
 * hash) — it looks up the tenant's actual Lead/Deal field list live and
 * matches by name, so you never need to go find the raw key by hand.
 * Leads and Deals share the same custom-field definitions in Pipedrive
 * (same reasoning as setup-pipedrive-fields.ts's dealFieldMap being
 * reused for Leads), so this reads from /dealFields even though the
 * fields will actually be read off Lead webhook payloads at runtime.
 *
 * Run (single field):
 *   npm run set-tenant-lead-source-field -- --tenant johari-developers --field "Social Form Source"
 *
 * Run (multiple, in priority order — first with a value wins):
 *   npm run set-tenant-lead-source-field -- --tenant johari-developers --field "Social Form Source,Lead Source"
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
import { listDealFields, listPersonFields } from "./lib/pipedrive";

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
      'Usage: npm run set-tenant-lead-source-field -- --tenant <slug> --field "<name>[,<name2>,...]"\n   or: npm run set-tenant-lead-source-field -- --tenant <slug> --clear'
    );
    process.exit(1);
  }

  const tenant = await db.tenant.findById(args.tenant);
  if (!tenant) {
    console.error(`No tenant found with slug "${args.tenant}". Run \`npm run list-tenants\` to see valid slugs.`);
    process.exit(1);
  }

  if (args.clear) {
    await db.tenant.updateLeadSourceFields(tenant.id, null);
    console.log(`Cleared the lead-source field mapping for "${tenant.name}" (${tenant.id}).`);
    return;
  }

  if (!args.field) {
    console.error('Provide --field "<name>[,<name2>,...]" (priority order), or --clear to remove an existing mapping.');
    process.exit(1);
  }

  if (!tenant.pipedriveApiToken) {
    console.error(`Tenant "${args.tenant}" has no Pipedrive API token set — nothing to look the field up against.`);
    process.exit(1);
  }

  console.log(`Fetching this tenant's Person and Deal/Lead fields from Pipedrive...`);
  const [personFields, dealFields] = await Promise.all([listPersonFields(tenant.pipedriveApiToken), listDealFields(tenant.pipedriveApiToken)]);
  // Deal/Lead checked first — matches this script's original,
  // single-entity behavior when a name happens to exist on both (an
  // ambiguous case; if you specifically need the Person-entity one,
  // use the dashboard's settings page instead, which disambiguates
  // clearly with "(Person)"/"(Deal/Lead)" labels).
  const allFields: { key: string; name: string; options: any; entity: "person" | "deal" }[] = [
    ...dealFields.map((f: any) => ({ ...f, entity: "deal" as const })),
    ...personFields.map((f: any) => ({ ...f, entity: "person" as const })),
  ];
  const wantedNames = args.field.split(",").map((s) => s.trim()).filter(Boolean);

  const resolved: { key: string; label: string; entity: "person" | "deal"; options: { id: string; name: string }[] }[] = [];
  for (const wantedName of wantedNames) {
    const wanted = wantedName.toLowerCase();
    const match = allFields.find((f) => typeof f.name === "string" && f.name.trim().toLowerCase() === wanted);
    if (!match) {
      const close = allFields.filter((f) => typeof f.name === "string" && f.name.toLowerCase().includes(wanted));
      console.error(`No field named exactly "${wantedName}" found.`);
      if (close.length) {
        console.error(`\nDid you mean one of these?`);
        close.forEach((f) => console.error(`  - "${f.name}" (${f.entity})`));
      } else {
        console.error(`\nAll available field names:`);
        allFields.forEach((f) => console.error(`  - "${f.name}" (${f.entity})`));
      }
      process.exit(1);
    }
    const options = Array.isArray(match.options) ? match.options.map((o: any) => ({ id: String(o.id), name: String(o.label) })) : [];
    resolved.push({ key: match.key, label: match.name, entity: match.entity, options });
  }

  await db.tenant.updateLeadSourceFields(tenant.id, JSON.stringify(resolved));
  console.log(
    `\nDone. "${tenant.name}" will now check, in this order, for any Lead whose contact has no other tracked touchpoints:\n` +
      resolved.map((f, i) => `  ${i + 1}. "${f.label}" (${f.entity}, field key ${f.key})`).join("\n")
  );
}

main()
  .catch((err) => {
    console.error("set-tenant-lead-source-field failed:", err.message || err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
