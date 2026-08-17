/**
 * One-time-per-client setup: creates (or reuses) the custom fields this
 * app writes attribution data into, on both the Person and Deal entities
 * in one client's Pipedrive account. Safe to re-run — it looks up fields
 * by name first and only creates what's missing, then saves the full
 * name -> key mapping onto that tenant's row for the sync code to use.
 *
 * Run with:
 *   pm2 stop journey-tracker
 *   npm run setup:pipedrive -- --tenant <slug>
 *   pm2 start journey-tracker
 *
 * The pm2 stop/start matters: this script's final step persists the new
 * field map to the shared sql.js DB file. If the live server is still
 * running, its own in-memory copy of that file (predating this write)
 * will get flushed back to disk on its own next persist() — e.g. the
 * very next touchpoint or webhook event — silently overwriting the field
 * map back to null with no error anywhere. When that happens, tracking
 * and the dashboard keep working fine, but every Pipedrive Person/Deal
 * custom field silently stays empty forever, since syncPersonAttribution
 * and freezeDealAttribution both no-op when personFieldMap/dealFieldMap
 * is null (see pipedrive-sync.ts). Same single-process caution as
 * add-tenant.ts/set-tenant-billing.ts/set-tenant-login.ts — this script
 * just didn't say so until this comment was added, after exactly this
 * happened once. Use debug-person.ts afterward (with pm2 still stopped)
 * to confirm the map actually landed before restarting.
 *
 * NOTE: this is the one part of the integration we couldn't verify
 * against a live Pipedrive account when this was first built — the exact
 * request/response shape for creating custom fields came from
 * documentation, not a live test. If it errors, the raw Pipedrive
 * response is printed below the error; share that and it's a quick fix.
 */
import "dotenv/config";
import { db } from "./db";
import { setupPipedriveFields } from "./lib/pipedrive-field-setup";

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
    console.error("Usage: npm run setup:pipedrive -- --tenant <slug>");
    process.exit(1);
  }

  const tenant = await db.tenant.findById(args.tenant);
  if (!tenant) {
    console.error(`Unknown tenant "${args.tenant}". Run npm run list-tenants to see what's onboarded.`);
    process.exit(1);
  }
  if (!tenant.pipedriveApiToken) {
    console.error(`Tenant "${tenant.id}" has no Pipedrive API token set yet — add one (see README) before running this.`);
    process.exit(1);
  }

  console.log(`Setting up Pipedrive custom fields for "${tenant.id}" (${tenant.name})\n`);

  await setupPipedriveFields(tenant.id, tenant.pipedriveApiToken, (msg) => console.log(msg));

  console.log(`\nSaved field map for tenant "${tenant.id}".`);
  console.log("\nDone. These fields are now visible in this client's Pipedrive under a Person or");
  console.log("Deal's Details tab, and can be added as columns, filters, or Insights report dimensions.");
}

main().catch((err) => {
  console.error("\nSetup failed:", err.message || err);
  console.error("\nIf this is a shape mismatch (e.g. field key not where expected), the raw error above has the Pipedrive response — that's what needs fixing in server/src/lib/pipedrive.ts.");
  process.exit(1);
});
