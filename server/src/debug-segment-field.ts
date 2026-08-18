/**
 * One-off diagnostic for the segment field feature — shows exactly what
 * Pipedrive returns for the tenant's configured segment field (its live
 * field definition, including whether/how it exposes `options`), and
 * optionally a specific Person's or Deal's raw value under that field
 * key. Built because "segment shows a raw ID (e.g. '412') instead of
 * the readable name" turned out to survive a re-save, meaning the
 * actual shape of Pipedrive's response differs from what
 * resolveSegmentName (lib/portal-summary.ts) currently assumes — this
 * shows real data instead of guessing a third time.
 *
 * Run with:
 *   npx ts-node src/debug-segment-field.ts --tenant <slug> [--person <id>] [--deal <id>]
 * Pass --person or --deal depending on which entity the tenant's
 * segment field is actually configured against (see "Parsed: entity=..."
 * in this script's own output) — checking the wrong one won't find the
 * value even when everything's working correctly, since Person and
 * Deal Labels are entirely separate label sets with separate IDs.
 * Read-only — safe to run alongside the live server, no need to stop pm2.
 */
import "dotenv/config";
import { db } from "./db";
import { listPersonFields, listDealFields, getPerson, getDeal } from "./lib/pipedrive";

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
    console.error("Usage: npx ts-node src/debug-segment-field.ts --tenant <slug> [--person <id>]");
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

  console.log("Stored segment field config:");
  console.log("  segmentFieldKey:", tenant.segmentFieldKey);
  console.log("  segmentFieldLabel:", tenant.segmentFieldLabel);
  console.log("  segmentFieldOptions:", tenant.segmentFieldOptions);

  if (!tenant.segmentFieldKey) {
    console.log("\nNo segment field configured for this tenant — nothing to check.");
    return;
  }

  const separatorIndex = tenant.segmentFieldKey.indexOf("::");
  if (separatorIndex === -1) {
    console.log(`\nStored key "${tenant.segmentFieldKey}" has no "entity::" prefix — this is a stale value from before that fix. Re-save the setting in the dashboard first.`);
    return;
  }
  const entity = tenant.segmentFieldKey.slice(0, separatorIndex);
  const rawKey = tenant.segmentFieldKey.slice(separatorIndex + 2);
  console.log(`\nParsed: entity="${entity}", rawKey="${rawKey}"`);

  console.log(`\nFetching live ${entity === "person" ? "Person" : "Deal"} fields from Pipedrive to find this field's current definition...`);
  const fields = entity === "person" ? await listPersonFields(tenant.pipedriveApiToken) : await listDealFields(tenant.pipedriveApiToken);
  // rawKey may already be normalized to "label_ids" (see
  // routes/portal.ts's normalizeFieldKeyForCapture) even though
  // Pipedrive's live field LIST still reports the built-in Label field
  // under its original key, "label" — check both so this doesn't print
  // a false "not found" for exactly the field this script is usually
  // being run to investigate.
  const match = fields.find((f: any) => f.key === rawKey || (rawKey === "label_ids" && f.key === "label"));
  if (!match) {
    console.log(`\nNo field with key "${rawKey}" found in live ${entity} fields — it may have been deleted/renamed in Pipedrive since this was configured.`);
  } else {
    console.log("\nFull live field definition (this is what listSegmentableFields sees when you open the settings dropdown):");
    console.log(JSON.stringify(match, null, 2));
    console.log(`\nmatch.options is ${Array.isArray(match.options) ? `an array of ${match.options.length} item(s)` : `NOT an array (typeof: ${typeof match.options})`} — this is exactly what gets saved as segmentFieldOptions.`);
  }

  if (args.person) {
    console.log(`\nFetching Person ${args.person} live to see the raw value stored under key "${rawKey}"...`);
    const person: any = await getPerson(tenant.pipedriveApiToken, Number(args.person));
    console.log("\nFull live Person record:");
    console.log(JSON.stringify(person, null, 2));
    console.log(`\nValue at person["${rawKey}"]:`, JSON.stringify(person?.[rawKey]));
    // v2 API sometimes nests custom field values under custom_fields
    // rather than as flat top-level properties — checking both since a
    // webhook payload and a live GET don't always share the same shape
    // (see extractPersonEmail's doc comment in webhooks.ts for a
    // precedent of exactly this kind of inconsistency).
    console.log(`Value at person.custom_fields?.["${rawKey}"]:`, JSON.stringify(person?.custom_fields?.[rawKey]));
  }

  if (args.deal) {
    console.log(`\nFetching Deal ${args.deal} live to see the raw value stored under key "${rawKey}"...`);
    const deal: any = await getDeal(tenant.pipedriveApiToken, Number(args.deal));
    console.log("\nFull live Deal record:");
    console.log(JSON.stringify(deal, null, 2));
    console.log(`\nValue at deal["${rawKey}"]:`, JSON.stringify(deal?.[rawKey]));
    console.log(`Value at deal.custom_fields?.["${rawKey}"]:`, JSON.stringify(deal?.custom_fields?.[rawKey]));
  }

  if (!args.person && !args.deal) {
    console.log("\n(Pass --person <id> or --deal <id> to also inspect a live record's raw value under this field key — use whichever entity this tenant's segment field is actually configured against, shown above as \"Parsed: entity=...\".)");
  }
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
