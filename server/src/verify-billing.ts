/**
 * Verifies the billing logic that doesn't require a live Stripe account —
 * status mapping, the dashboard access-gate decision, and default/partial
 * DB writes for the billing columns on `tenants`. What this deliberately
 * does NOT cover: actually calling the Stripe API (createCheckoutSession,
 * createBillingPortalSession, constructStripeEvent) or a real webhook
 * round trip — those need a real (or Stripe CLI-simulated) account and
 * are exercised manually, the same way setup:pipedrive's actual field
 * creation isn't covered by verify-attribution.ts either.
 *
 * Run with: npm run verify-billing
 */
import assert from "assert";
import { db } from "./db";
import { mapSubscriptionStatus, isBillingActive } from "./lib/stripe";

async function main() {
  // --- mapSubscriptionStatus ---
  assert.strictEqual(mapSubscriptionStatus("trialing"), "trialing");
  assert.strictEqual(mapSubscriptionStatus("active"), "active");
  assert.strictEqual(mapSubscriptionStatus("past_due"), "past_due");
  assert.strictEqual(mapSubscriptionStatus("unpaid"), "past_due", "unpaid folds into past_due — this app doesn't distinguish the two");
  assert.strictEqual(mapSubscriptionStatus("canceled"), "canceled");
  assert.strictEqual(mapSubscriptionStatus("incomplete_expired"), "canceled", "an expired incomplete subscription is treated the same as canceled — never billed, never will be without starting over");
  assert.strictEqual(mapSubscriptionStatus("incomplete"), "incomplete");
  assert.strictEqual(mapSubscriptionStatus("paused" as any), "past_due", "unrecognized/future Stripe statuses default to the gated side, not the open side");
  console.log("✅ mapSubscriptionStatus: every known Stripe status maps to a local status, unknowns default to gated");

  // --- isBillingActive ---
  assert.strictEqual(isBillingActive("trialing"), true);
  assert.strictEqual(isBillingActive("active"), true);
  assert.strictEqual(isBillingActive("exempt"), true);
  assert.strictEqual(isBillingActive("incomplete"), false);
  assert.strictEqual(isBillingActive("past_due"), false);
  assert.strictEqual(isBillingActive("canceled"), false);
  console.log("✅ isBillingActive: trialing/active/exempt pass, everything else is gated");

  // --- db.tenant.create default subscriptionStatus ---
  const cliTenant = await db.tenant.create({
    id: `verify-billing-cli-${Date.now()}`,
    name: "CLI Test Co",
    trackKey: "tk1",
    webhookSecret: "wh1",
    // signupSource omitted — mirrors add-tenant.ts, which never passes it
  });
  const selfServeTenant = await db.tenant.create({
    id: `verify-billing-ss-${Date.now()}`,
    name: "Self-Serve Test Co",
    trackKey: "tk2",
    webhookSecret: "wh2",
    signupEmail: `verify-billing-${Date.now()}@example.com`,
    passwordHash: "irrelevant",
    signupSource: "self_serve",
  });
  try {
    assert.strictEqual(cliTenant.subscriptionStatus, "exempt", "a CLI-onboarded tenant (add-tenant.ts) should never be billing-gated");
    assert.strictEqual(selfServeTenant.subscriptionStatus, "incomplete", "a fresh self-serve signup starts incomplete until Checkout completes");
    console.log("✅ db.tenant.create: signupSource drives the default subscriptionStatus (cli -> exempt, self_serve -> incomplete)");

    // --- db.tenant.updateBilling: partial update + Date round-trip ---
    const trialEndsAt = new Date("2026-09-01T12:00:00.000Z");
    const currentPeriodEnd = new Date("2026-09-01T12:00:00.000Z");
    await db.tenant.updateBilling(selfServeTenant.id, {
      stripeCustomerId: "cus_test123",
      stripeSubscriptionId: "sub_test123",
      subscriptionStatus: "trialing",
      trialEndsAt,
      currentPeriodEnd,
    });
    let reloaded = await db.tenant.findById(selfServeTenant.id);
    assert.strictEqual(reloaded?.subscriptionStatus, "trialing");
    assert.strictEqual(reloaded?.stripeCustomerId, "cus_test123");
    assert.strictEqual(reloaded?.trialEndsAt?.getTime(), trialEndsAt.getTime(), "trialEndsAt should round-trip through the DB as a real Date");
    assert.strictEqual(reloaded?.currentPeriodEnd?.getTime(), currentPeriodEnd.getTime());

    // A later webhook event that only touches status (e.g. going
    // past_due) must not clobber the Stripe ids or dates already saved —
    // same "explicitly undefined = don't touch" semantics as
    // db.identity.update/setDealMilestone.
    await db.tenant.updateBilling(selfServeTenant.id, { subscriptionStatus: "past_due" });
    reloaded = await db.tenant.findById(selfServeTenant.id);
    assert.strictEqual(reloaded?.subscriptionStatus, "past_due");
    assert.strictEqual(reloaded?.stripeCustomerId, "cus_test123", "a status-only update should not wipe the previously saved Stripe customer id");
    assert.strictEqual(reloaded?.trialEndsAt?.getTime(), trialEndsAt.getTime(), "a status-only update should not wipe the previously saved trial end date");
    console.log("✅ db.tenant.updateBilling: partial updates persist and don't clobber previously saved billing fields");

    // --- lookups ---
    const byCustomer = await db.tenant.findByStripeCustomerId("cus_test123");
    assert.strictEqual(byCustomer?.id, selfServeTenant.id);
    const bySubscription = await db.tenant.findByStripeSubscriptionId("sub_test123");
    assert.strictEqual(bySubscription?.id, selfServeTenant.id);
    const byMissingCustomer = await db.tenant.findByStripeCustomerId("cus_does_not_exist");
    assert.strictEqual(byMissingCustomer, null);
    console.log("✅ db.tenant.findByStripeCustomerId/findByStripeSubscriptionId: resolve the right tenant, null on no match");
  } finally {
    await db.tenant.delete(cliTenant.id);
    await db.tenant.delete(selfServeTenant.id);
  }

  console.log("\n✅ All billing logic checks passed.");
}

main()
  .catch((err) => {
    console.error("\n❌ verify-billing failed:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
