/**
 * Verifies the attribution logic and per-tenant field-map persistence
 * used by the custom-fields sync path — everything that doesn't require
 * a live Pipedrive account (the actual field-creation API calls do;
 * that part is exercised by `npm run setup:pipedrive` against a real
 * account, not here). Run with: npm run verify-attribution
 */
import assert from "assert";
import crypto from "crypto";
import { db, Touchpoint } from "./db";
import { buildAttributionSummary, buildAttributionAsOf } from "./lib/attribution";
import { toCustomFieldsPayload } from "./lib/pipedrive";
import { countTouchpointsUpTo, countTouchpointsBetween } from "./lib/deal-milestones";
import { signJourneyToken, verifyJourneyToken, journeyLinkUrl } from "./lib/journey-link";

function tp(partial: Partial<Touchpoint>): Touchpoint {
  return {
    id: partial.id || Math.random().toString(36).slice(2),
    tenantId: "test-tenant",
    identityId: "id1",
    anonymousId: null,
    channel: "website_visit",
    source: "website",
    campaign: null,
    medium: null,
    content: null,
    term: null,
    clickId: null,
    gclid: null,
    fbclid: null,
    msclkid: null,
    referrer: null,
    url: null,
    title: null,
    metadata: null,
    durationMs: null,
    createdAt: new Date(),
    occurredAt: new Date(),
    ...partial,
  };
}

async function main() {
  // --- buildAttributionSummary ---
  const touchpoints = [
    tp({ channel: "ad_click", source: "linkedin_ads", campaign: "Q3-awareness", occurredAt: new Date("2026-07-01") }),
    tp({ channel: "website_visit", source: "website", url: "/blog/compare", occurredAt: new Date("2026-07-15") }),
    tp({ channel: "website_visit", source: "google_organic", url: "/signup", occurredAt: new Date("2026-08-01") }),
    tp({ channel: "pipedrive_stage_change", source: "pipedrive", title: "Deal won", occurredAt: new Date("2026-08-10") }),
  ];

  const summary = buildAttributionSummary(touchpoints);
  assert.ok(summary, "summary should not be null for a non-empty touchpoint list");
  assert.strictEqual(summary!.firstTouchChannel, "Ad click");
  assert.strictEqual(summary!.firstTouchSource, "linkedin_ads");
  assert.strictEqual(summary!.firstTouchCampaign, "Q3-awareness");
  assert.strictEqual(summary!.firstTouchDate, "2026-07-01");
  assert.strictEqual(summary!.lastTouchChannel, "Deal stage");
  assert.strictEqual(summary!.touchpointCount, 4);
  assert.ok(summary!.summaryText.includes("Ad click"), "summary text should mention the first touch");
  assert.ok(summary!.summaryText.split("\n").length === 4, "summary text should have one line per touchpoint");
  console.log("✅ buildAttributionSummary: first/last touch, count, and summary text are correct");

  // --- GCLID / FBCLID / MSCLKID / referrer / landing page (first + last touch) ---
  const clickIdTouchpoints = [
    tp({
      channel: "ad_click",
      source: "google_ads",
      gclid: "gclid-abc",
      referrer: "https://www.google.com/",
      url: "https://example.com/landing-a",
      occurredAt: new Date("2026-07-01"),
    }),
    tp({
      channel: "website_visit",
      source: "website",
      url: "https://example.com/pricing",
      occurredAt: new Date("2026-07-10"),
    }),
    tp({
      channel: "ad_click",
      source: "facebook_ads",
      fbclid: "fbclid-xyz",
      referrer: "https://www.facebook.com/",
      url: "https://example.com/landing-b",
      occurredAt: new Date("2026-07-20"),
    }),
  ];
  const clickIdSummary = buildAttributionSummary(clickIdTouchpoints);
  assert.ok(clickIdSummary);
  assert.strictEqual(clickIdSummary!.firstTouchGclid, "gclid-abc", "first touch should carry the original gclid");
  assert.strictEqual(clickIdSummary!.firstTouchFbclid, null, "first touch had no fbclid");
  assert.strictEqual(clickIdSummary!.firstTouchReferrer, "https://www.google.com/");
  assert.strictEqual(clickIdSummary!.firstTouchLandingPage, "https://example.com/landing-a");
  assert.strictEqual(clickIdSummary!.lastTouchFbclid, "fbclid-xyz", "last touch should carry the most recent fbclid");
  assert.strictEqual(clickIdSummary!.lastTouchGclid, null, "last touch had no gclid — should not inherit the first touch's");
  assert.strictEqual(clickIdSummary!.lastTouchReferrer, "https://www.facebook.com/");
  assert.strictEqual(clickIdSummary!.lastTouchLandingPage, "https://example.com/landing-b");
  console.log("✅ buildAttributionSummary: gclid/fbclid/msclkid/referrer/landing page tracked independently for first vs. last touch");

  assert.strictEqual(buildAttributionSummary([]), null, "empty touchpoint list should yield no summary");
  console.log("✅ buildAttributionSummary: empty input returns null instead of throwing");

  // --- buildAttributionAsOf (deal-creation freeze) ---
  const asOfBeforeSignup = buildAttributionAsOf(touchpoints, new Date("2026-07-20"));
  assert.ok(asOfBeforeSignup);
  assert.strictEqual(asOfBeforeSignup!.touchpointCount, 2, "cutoff should exclude touchpoints after it");
  assert.strictEqual(asOfBeforeSignup!.lastTouchChannel, "Website");
  console.log("✅ buildAttributionAsOf: correctly excludes touchpoints after the cutoff (deal-creation freeze)");

  // --- toCustomFieldsPayload ---
  const payload = toCustomFieldsPayload({
    field_key_1: "Ad click",
    field_key_2: "",
    field_key_3: 4,
    field_key_4: undefined as any,
  });
  assert.deepStrictEqual(payload, { field_key_1: "Ad click", field_key_3: 4 });
  console.log("✅ toCustomFieldsPayload: passes v2 simple-field values through directly, drops empty/undefined so partial syncs don't blank fields");

  // --- countTouchpointsUpTo / countTouchpointsBetween (deal-lifecycle milestones) ---
  const milestoneTouchpoints = [
    tp({ occurredAt: new Date("2026-08-01T00:00:00Z") }), // before deal creation
    tp({ occurredAt: new Date("2026-08-02T00:00:00Z") }), // before deal creation
    tp({ occurredAt: new Date("2026-08-03T00:00:00Z") }), // exactly at deal creation
    tp({ occurredAt: new Date("2026-08-04T00:00:00Z") }), // between deal creation and won
    tp({ occurredAt: new Date("2026-08-05T00:00:00Z") }), // exactly at won
    tp({ occurredAt: new Date("2026-08-06T00:00:00Z") }), // after won — shouldn't count anywhere
  ];
  const dealCreatedAt = new Date("2026-08-03T00:00:00Z");
  const wonAt = new Date("2026-08-05T00:00:00Z");

  assert.strictEqual(
    countTouchpointsUpTo(milestoneTouchpoints, dealCreatedAt),
    3,
    "should include the two touchpoints strictly before the cutoff plus the one exactly AT it"
  );
  assert.strictEqual(
    countTouchpointsBetween(milestoneTouchpoints, dealCreatedAt, wonAt),
    2,
    "should exclude the creation-moment touchpoint (already counted above), include the one strictly between, and include the one exactly AT won"
  );
  assert.strictEqual(
    countTouchpointsUpTo(milestoneTouchpoints, dealCreatedAt) + countTouchpointsBetween(milestoneTouchpoints, dealCreatedAt, wonAt),
    5,
    "the two milestones together should account for every touchpoint up to and including won, with no double-count at the shared boundary"
  );
  assert.strictEqual(countTouchpointsUpTo([], dealCreatedAt), 0, "empty touchpoint list should count as zero, not throw");
  assert.strictEqual(
    countTouchpointsBetween(milestoneTouchpoints, wonAt, wonAt),
    0,
    "a zero-width window (start === end) should count as zero, not include the boundary touchpoint twice"
  );
  console.log("✅ countTouchpointsUpTo/countTouchpointsBetween: correct at exact-boundary timestamps, no double-count or gap at the shared cutoff");

  // --- per-tenant field map round trip (now stored on the tenant row, not a shared file) ---
  const slug = `verify-fieldmap-${Date.now()}`;
  const tenant = await db.tenant.create({
    id: slug,
    name: "Verify Field Map Tenant",
    trackKey: crypto.randomBytes(8).toString("hex"),
    webhookSecret: crypto.randomBytes(8).toString("hex"),
  });
  try {
    assert.strictEqual(tenant.personFieldMap, null, "no field map yet on a freshly created tenant");

    const maps = {
      person: { first_touch_channel: "abc123" },
      deal: { deal_first_touch_channel: "def456" },
    };
    await db.tenant.updateFieldMaps(tenant.id, maps);

    const reloaded = await db.tenant.findById(tenant.id);
    assert.deepStrictEqual(reloaded?.personFieldMap, maps.person, "person field map should round-trip");
    assert.deepStrictEqual(reloaded?.dealFieldMap, maps.deal, "deal field map should round-trip");
    console.log("✅ per-tenant field map: persists and reloads correctly, scoped to that tenant's row");

    // --- journey link signing/verification (lib/journey-link.ts) ---
    const identityIdA = "identity-aaa";
    const identityIdB = "identity-bbb";
    const otherTenant = { ...reloaded!, id: "other-tenant", webhookSecret: crypto.randomBytes(8).toString("hex") };

    const tokenA1 = signJourneyToken(reloaded!, identityIdA);
    const tokenA2 = signJourneyToken(reloaded!, identityIdA);
    assert.strictEqual(tokenA1, tokenA2, "signing the same tenant+identity twice should be deterministic");
    assert.notStrictEqual(tokenA1, signJourneyToken(reloaded!, identityIdB), "different identities under the same tenant should get different tokens");
    assert.notStrictEqual(tokenA1, signJourneyToken(otherTenant, identityIdA), "the same identityId under a different tenant's secret should get a different token");

    assert.strictEqual(verifyJourneyToken(reloaded!, identityIdA, tokenA1), true, "a token verifies against the tenant+identity it was signed for");
    assert.strictEqual(verifyJourneyToken(reloaded!, identityIdB, tokenA1), false, "a token must not verify against a different identityId");
    assert.strictEqual(verifyJourneyToken(otherTenant, identityIdA, tokenA1), false, "a token must not verify against a different tenant's secret");
    assert.strictEqual(verifyJourneyToken(reloaded!, identityIdA, "not-the-token"), false, "a wrong token is rejected");
    assert.strictEqual(verifyJourneyToken(reloaded!, identityIdA, undefined), false, "a missing token is rejected, not thrown on");
    console.log("✅ signJourneyToken/verifyJourneyToken: deterministic, scoped to exactly one tenant+identity pair, wrong/missing tokens rejected");

    const savedBaseUrl = process.env.PUBLIC_BASE_URL;
    try {
      delete process.env.PUBLIC_BASE_URL;
      assert.strictEqual(journeyLinkUrl(reloaded!, identityIdA), null, "with PUBLIC_BASE_URL unset, journeyLinkUrl should return null rather than build a broken link");

      process.env.PUBLIC_BASE_URL = "https://attribution.example.com/";
      const url = journeyLinkUrl(reloaded!, identityIdA);
      assert.ok(url, "journeyLinkUrl should return a URL once PUBLIC_BASE_URL is set");
      assert.strictEqual(url!.startsWith("https://attribution.example.com/attribution/journey/identity-aaa?"), true, "trailing slash on PUBLIC_BASE_URL should be stripped, not double up");
      assert.ok(url!.includes(`tenant=${encodeURIComponent(reloaded!.id)}`), "the link should carry the tenant id so /attribution/api/journey can resolve which secret to verify against");
      assert.ok(url!.includes(`token=${tokenA1}`), "the link's token should match what signJourneyToken produces for the same tenant+identity");
    } finally {
      if (savedBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = savedBaseUrl;
    }
    console.log("✅ journeyLinkUrl: null without PUBLIC_BASE_URL configured, otherwise a well-formed link carrying the matching token");

    // --- db.identity.setDealMilestone round trip ---
    const identity = await db.identity.create({ data: { tenantId: tenant.id, email: "milestone-test@example.com" } });
    assert.strictEqual(identity.leadToDealTouchpoints, null, "no milestone set yet on a freshly created identity");
    assert.strictEqual(identity.dealCreatedAt, null);

    const afterCreated = await db.identity.setDealMilestone({
      where: { tenantId: tenant.id, id: identity.id },
      data: { dealCreatedDealId: 999, dealCreatedAt, leadToDealTouchpoints: 3 },
    });
    assert.strictEqual(afterCreated.dealCreatedDealId, 999);
    assert.strictEqual(afterCreated.leadToDealTouchpoints, 3);
    assert.strictEqual(afterCreated.wonDealId, null, "won milestone should still be unset");

    const afterWon = await db.identity.setDealMilestone({
      where: { tenantId: tenant.id, id: identity.id },
      data: { wonDealId: 999, dealToWonTouchpoints: 2 },
    });
    assert.strictEqual(afterWon.dealCreatedDealId, 999, "setting the won milestone should not clobber the already-set created milestone");
    assert.strictEqual(afterWon.leadToDealTouchpoints, 3, "same — leadToDealTouchpoints should survive an update that only touches won fields");
    assert.strictEqual(afterWon.wonDealId, 999);
    assert.strictEqual(afterWon.dealToWonTouchpoints, 2);

    const reloadedIdentity = await db.identity.findUnique({ where: { tenantId: tenant.id, id: identity.id } });
    assert.strictEqual(reloadedIdentity?.dealCreatedAt?.getTime(), dealCreatedAt.getTime(), "dealCreatedAt should round-trip through the DB as a real Date");
    assert.strictEqual(reloadedIdentity?.dealToWonTouchpoints, 2, "both milestones should still be there after a fresh read from the DB");
    console.log("✅ db.identity.setDealMilestone: both milestones persist independently and survive a partial update + reload");
  } finally {
    await db.tenant.delete(tenant.id);
  }

  console.log("\n✅ All attribution/custom-fields logic checks passed.");
}

main()
  .catch((err) => {
    console.error("\n❌ verify-attribution failed:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
