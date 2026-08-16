/**
 * Standalone smoke test: exercises identity resolution end-to-end by
 * simulating the exact scenario from the LinkedIn post this project was
 * inspired by, for one client tenant —
 *
 *   1. Anonymous visitor clicks a LinkedIn ad, lands on the site (no email yet)
 *   2. Same visitor reads a comparison blog two weeks later (still anonymous)
 *   3. A month later they Google the brand and sign up directly (now identified)
 *   4. Pipedrive fires a person.create webhook confirming the same email
 *   5. A deal tied to that person moves to "Won"
 *
 * Asserts that all four resulting touchpoints end up on ONE identity, in
 * order, instead of last-click swallowing the earlier ones, and that a
 * second tenant's identical activity stays completely separate — the
 * whole point of the multi-tenant rewrite. Run with: npm run smoke-test
 */
import "dotenv/config";
import crypto from "crypto";
import { db, Tenant } from "./db";
import { recordTouchpoint, mergeIdentities } from "./lib/identity";

async function getOrCreateTestTenant(slug: string, name: string): Promise<Tenant> {
  const existing = await db.tenant.findById(slug);
  if (existing) return existing;
  return db.tenant.create({
    id: slug,
    name,
    trackKey: crypto.randomBytes(8).toString("hex"),
    webhookSecret: crypto.randomBytes(8).toString("hex"),
  });
}

async function runJourney(tenant: Tenant, email: string, anonId: string, pipedrivePersonId: number) {
  const day = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  await recordTouchpoint(tenant, {
    channel: "ad_click",
    source: "linkedin_ads",
    campaign: "Q3-awareness",
    clickId: "li_fat_id_abc123",
    anonymousId: anonId,
    occurredAt: day(45),
  });

  await recordTouchpoint(tenant, {
    channel: "website_visit",
    source: "website",
    url: "/blog/x-vs-y-comparison",
    title: "X vs Y: full comparison",
    anonymousId: anonId,
    occurredAt: day(31),
  });

  await mergeIdentities(tenant, { email, anonymousId: anonId });
  await recordTouchpoint(tenant, {
    channel: "website_visit",
    source: "google_organic",
    url: "/signup",
    title: "Signed up",
    email,
    anonymousId: anonId,
    occurredAt: day(0),
  });

  const identity = await mergeIdentities(tenant, { email, pipedrivePersonId });

  await recordTouchpoint(tenant, {
    channel: "pipedrive_stage_change",
    source: "pipedrive",
    title: 'Deal "Smoke Test Co" moved to Won',
    metadata: { dealId: 123456, stageId: 4, status: "won" },
    pipedrivePersonId,
    occurredAt: new Date(),
  });

  return identity;
}

async function main() {
  const suffix = Date.now();

  console.log("Setting up two separate test tenants (to prove tenant isolation)...");
  const tenantA = await getOrCreateTestTenant(`smoketest-a-${suffix}`, "Smoke Test Co A");
  const tenantB = await getOrCreateTestTenant(`smoketest-b-${suffix}`, "Smoke Test Co B");

  console.log("\n[Tenant A] Running the ad-click -> blog -> signup -> deal-won journey...");
  const identityA = await runJourney(tenantA, "smoketest@example.com", `anon_a_${suffix}`, 999001);

  console.log("[Tenant B] Running the identical journey under the SAME email, different tenant...");
  const identityB = await runJourney(tenantB, "smoketest@example.com", `anon_b_${suffix}`, 999002);

  const touchpointsA = await db.touchpoint.findMany({
    where: { tenantId: tenantA.id, identityId: identityA.id },
    orderBy: { occurredAt: "asc" },
  });
  const touchpointsB = await db.touchpoint.findMany({
    where: { tenantId: tenantB.id, identityId: identityB.id },
    orderBy: { occurredAt: "asc" },
  });

  console.log(`\n[Tenant A] Resolved ${touchpointsA.length} touchpoints onto ONE identity (${identityA.id}):`);
  for (const t of touchpointsA) {
    console.log(`  [${t.occurredAt.toISOString().slice(0, 10)}] ${t.channel.padEnd(22)} ${t.source}${t.campaign ? ` (${t.campaign})` : ""}`);
  }

  try {
    // Steps 1, 2, 3 and 5 each record a touchpoint; the person.create
    // webhook step only confirms the identity match, it doesn't add a
    // journey event of its own.
    if (touchpointsA.length !== 4) {
      throw new Error(`Expected 4 touchpoints for tenant A, got ${touchpointsA.length}`);
    }
    if (touchpointsA[0].channel !== "ad_click") {
      throw new Error("Expected the LinkedIn ad click to be the first touchpoint in tenant A's journey");
    }
    console.log("✅ Tenant A: full journey preserved across anonymous -> identified -> Pipedrive stages, not collapsed to last-click.");

    if (touchpointsB.length !== 4) {
      throw new Error(`Expected 4 touchpoints for tenant B, got ${touchpointsB.length}`);
    }
    console.log("✅ Tenant B: same email, completely independent journey — no cross-tenant leakage.");

    if (identityA.id === identityB.id) {
      throw new Error("Tenant A and Tenant B resolved to the SAME identity row — tenant isolation is broken");
    }
    console.log("✅ Tenant isolation: identical email in two tenants produced two separate identities.");

    // Cross-check: tenant A's touchpoint query should never see tenant B's
    // rows even though both used the same email and similar anonymous IDs.
    const crossCheck = await db.touchpoint.findMany({
      where: { tenantId: tenantA.id, identityId: identityB.id },
      orderBy: { occurredAt: "asc" },
    });
    if (crossCheck.length !== 0) {
      throw new Error("Querying tenant A's touchpoints for tenant B's identityId returned rows — data leaked across tenants");
    }
    console.log("✅ Cross-tenant query returns nothing, as expected.");
  } finally {
    // Cleanup so re-runs stay idempotent even if an assertion above failed
    // — delete the whole test tenants, not just their touchpoints.
    await db.tenant.delete(tenantA.id);
    await db.tenant.delete(tenantB.id);
  }

  console.log("\n✅ Smoke test passed.");
}

main()
  .catch((err) => {
    console.error("\n❌ Smoke test failed:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
