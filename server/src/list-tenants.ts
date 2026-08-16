/**
 * Quick visibility into which clients are onboarded. Run: npm run list-tenants
 */
import "dotenv/config";
import { db } from "./db";

async function main() {
  const tenants = await db.tenant.list();
  if (tenants.length === 0) {
    console.log("No tenants yet — run `npm run add-tenant -- --slug ... --name ...` to create one.");
    return;
  }

  console.log(`${tenants.length} tenant(s):\n`);
  for (const t of tenants) {
    console.log(`- ${t.id} (${t.name})`);
    console.log(`    Pipedrive token: ${t.pipedriveApiToken ? "set" : "NOT SET"}`);
    console.log(`    Custom fields:   ${t.personFieldMap ? "set up" : "not run yet (npm run setup:pipedrive)"}`);
    console.log(`    Billing:         ${t.subscriptionStatus}${t.subscriptionStatus === "incomplete" ? "  <- gated, dashboard blocked until they pay or you run set-tenant-billing" : ""}`);
    console.log(`    Created:         ${t.createdAt.toISOString().slice(0, 10)}`);
  }
}

main().catch((err) => {
  console.error("list-tenants failed:", err.message || err);
  process.exit(1);
});
