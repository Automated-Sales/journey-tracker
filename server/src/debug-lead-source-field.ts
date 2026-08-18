/**
 * One-off diagnostic for the "Lead source fallback" feature — shows the
 * tenant's stored configuration (fields, labels, entities, cached
 * options) and, given a real Lead ID and/or Person ID, the RAW value
 * Pipedrive actually returns for each field. Fields can now live on
 * EITHER Person or Deal/Lead (see db.ts's Tenant.leadSourceFields doc
 * comment) — pass whichever ID(s) match the entity type(s) actually
 * configured.
 *
 * Run with:
 *   npx ts-node src/debug-lead-source-field.ts --tenant <slug> [--lead <lead-uuid>] [--person <id>]
 * Read-only — safe to run alongside the live server, no need to stop pm2.
 *
 * The Lead ID is a UUID, visible in that Lead's own Pipedrive URL
 * (…/leads/inbox/<this-part>). The Person ID is numeric.
 */
import "dotenv/config";
import { db } from "./db";
import { getLead, getPerson } from "./lib/pipedrive";

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
    console.error("Usage: npx ts-node src/debug-lead-source-field.ts --tenant <slug> [--lead <lead-uuid>] [--person <id>]");
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

  console.log("Stored lead-source-fields config (priority order):");
  let fields: { key: string; label: string; entity?: "person" | "deal"; options: { id: string; name: string }[] }[] = [];
  try {
    fields = tenant.leadSourceFields ? JSON.parse(tenant.leadSourceFields) : [];
  } catch {
    fields = [];
  }
  if (!fields.length) {
    console.log("  (none configured)");
    console.log("\nNo lead-source fields configured for this tenant — nothing to check.");
    return;
  }
  fields.forEach((f, i) =>
    console.log(`  ${i + 1}. entity="${f.entity || "deal (legacy, no entity stored)"}" key="${f.key}" label="${f.label}" options=${JSON.stringify(f.options)}`)
  );

  const dealFields = fields.filter((f) => (f.entity || "deal") === "deal");
  const personFields = fields.filter((f) => f.entity === "person");

  if (!args.lead && !args.person) {
    console.log("\n(Pass --lead <lead-uuid> to check the Deal/Lead-entity fields above, and/or --person <id> to check the Person-entity ones.)");
    return;
  }

  if (args.lead) {
    if (!dealFields.length) {
      console.log("\nNo Deal/Lead-entity fields configured — skipping the --lead check.");
    } else {
      console.log(`\nFetching Lead ${args.lead} live...`);
      const lead: any = await getLead(tenant.pipedriveApiToken, args.lead);
      console.log("\nFull live Lead record:");
      console.log(JSON.stringify(lead, null, 2));
      console.log("\nValue under each configured Deal/Lead-entity field's key (priority order — first non-empty one is what the fallback would actually use):");
      dealFields.forEach((f, i) => console.log(`  ${i + 1}. "${f.label}" (${f.key}):`, JSON.stringify(lead?.[f.key])));
    }
  }

  if (args.person) {
    if (!personFields.length) {
      console.log("\nNo Person-entity fields configured — skipping the --person check.");
    } else {
      console.log(`\nFetching Person ${args.person} live...`);
      const person: any = await getPerson(tenant.pipedriveApiToken, Number(args.person));
      console.log("\nFull live Person record:");
      console.log(JSON.stringify(person, null, 2));
      console.log("\nValue under each configured Person-entity field's key (priority order):");
      personFields.forEach((f, i) => console.log(`  ${i + 1}. "${f.label}" (${f.key}):`, JSON.stringify(person?.[f.key])));
    }
  }
}

main()
  .catch((err) => {
    console.error("\nFailed:", err.message || err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
