/**
 * Unit-level checks for the self-serve portal's pure/DB-only logic —
 * password hashing, sessions, signup validation/provisioning, and the
 * dashboard's aggregate summary computation. Deliberately does NOT call
 * out to Pipedrive (getMe) — this sandbox has no outbound network path to
 * api.pipedrive.com to test against (confirmed directly: a plain curl to
 * it from this environment gets connection-reset, unlike github.com or
 * the doc sites WebFetch can reach). The signup route's live-token-check
 * step is therefore the one piece of this feature that mirrors the
 * existing `setup:pipedrive` gap — see README.
 *
 * What IS exercised against a live server, over real HTTP: the full
 * login -> session cookie -> /me -> /summary -> logout -> 401 cycle, in
 * verify-portal-http.sh, using a tenant inserted directly (bypassing the
 * network-dependent signup step).
 */
import "dotenv/config";
import { db } from "./db";
import { hashPassword, verifyPassword } from "./lib/auth";
import { validateSignupForm, provisionSelfServeTenant } from "./lib/portal-signup";
import { buildPortalSummary, filterProspects, filterIdentities, paginateProspects } from "./lib/portal-summary";
import { buildProspectsCsv, buildCampaignsCsv, buildGoogleAdsConversionsCsv, buildMicrosoftAdsConversionsCsv, buildLinkedInAdsConversionsCsv } from "./lib/csv";
import { Identity, Touchpoint } from "./db";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`✅ ${msg}`);
}

function fixtureTouchpoint(overrides: Partial<Touchpoint>): Touchpoint {
  return {
    id: overrides.id || Math.random().toString(36).slice(2),
    tenantId: "t1",
    identityId: overrides.identityId ?? null,
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
    liFatId: null,
    referrer: null,
    url: null,
    title: null,
    metadata: null,
    durationMs: null,
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fixtureIdentity(overrides: Partial<Identity>): Identity {
  return {
    id: overrides.id || Math.random().toString(36).slice(2),
    tenantId: "t1",
    email: null,
    name: null,
    phone: null,
    anonymousIds: "",
    pipedrivePersonId: null,
    pipedriveDealIds: "",
    pipedriveLeadIds: "",
    leadCreatedAt: null,
    leadCreatedLeadId: null,
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    dealCreatedDealId: null,
    dealCreatedAt: null,
    leadToDealTouchpoints: null,
    wonDealId: null,
    dealToWonTouchpoints: null,
    dealWonAt: null,
    dealValue: null,
    dealCurrency: null,
    dealValueAtCreate: null,
    dealCurrencyAtCreate: null,
    segmentValue: null,
    dealCurrentStageId: null,
    dealCurrentStageName: null,
    ...overrides,
  };
}

async function main() {
  // --- password hashing --------------------------------------------
  const hash = hashPassword("correct horse battery staple");
  assert(verifyPassword("correct horse battery staple", hash), "hashPassword/verifyPassword: correct password verifies");
  assert(!verifyPassword("wrong password", hash), "hashPassword/verifyPassword: wrong password is rejected");
  assert(!verifyPassword("correct horse battery staple", null), "verifyPassword: null stored hash never verifies");
  assert(hash.split(":").length === 2 && hash.split(":")[0].length === 32, "hashPassword: stores salt:derived, salt is 16 random bytes");

  // --- signup form validation ---------------------------------------
  assert(
    validateSignupForm({ companyName: "", email: "a@b.com", password: "12345678", pipedriveToken: "x" }) !== null,
    "validateSignupForm: rejects missing company name"
  );
  assert(
    validateSignupForm({ companyName: "Acme", email: "not-an-email", password: "12345678", pipedriveToken: "x" }) !== null,
    "validateSignupForm: rejects malformed email"
  );
  assert(
    validateSignupForm({ companyName: "Acme", email: "a@b.com", password: "short", pipedriveToken: "x" }) !== null,
    "validateSignupForm: rejects password under 8 characters"
  );
  assert(
    validateSignupForm({ companyName: "Acme", email: "a@b.com", password: "12345678", pipedriveToken: "" }) !== null,
    "validateSignupForm: rejects missing Pipedrive token"
  );
  assert(
    validateSignupForm({ companyName: "Acme", email: "a@b.com", password: "12345678", pipedriveToken: "tok123" }) === null,
    "validateSignupForm: accepts a well-formed submission"
  );

  // --- signup provisioning (DB writes, no network) -------------------
  const testEmail = `verify-portal-${Date.now()}@example.com`;
  const tenant = await provisionSelfServeTenant({
    companyName: "Verify Portal Test Co!!",
    email: testEmail,
    password: "hunter22222",
    pipedriveToken: "fake-token-abc",
    me: { id: 1, email: testEmail, name: "Test User", companyId: 99, companyName: "Verify Portal Test Co", companyDomain: "verifyportal" },
  });
  assert(tenant.id.startsWith("verify-portal-test-co"), `provisionSelfServeTenant: slugifies company name into tenant id (got "${tenant.id}")`);
  assert(tenant.signupSource === "self_serve", "provisionSelfServeTenant: marks signupSource as self_serve");
  assert(tenant.pipedriveCompanyDomain === "verifyportal", "provisionSelfServeTenant: stores the company domain from /users/me");
  assert(verifyPassword("hunter22222", tenant.passwordHash), "provisionSelfServeTenant: password is hashed and verifiable");

  let duplicateRejected = false;
  try {
    await provisionSelfServeTenant({
      companyName: "Another Co",
      email: testEmail,
      password: "differentpassword",
      pipedriveToken: "another-token",
      me: { id: 2, email: testEmail, name: "Other", companyId: 100, companyName: "Another Co", companyDomain: "another" },
    });
  } catch {
    duplicateRejected = true;
  }
  assert(duplicateRejected, "provisionSelfServeTenant: rejects signup with an email already in use");

  const secondTenant = await provisionSelfServeTenant({
    companyName: "Verify Portal Test Co!!",
    email: `verify-portal-2-${Date.now()}@example.com`,
    password: "hunter22222",
    pipedriveToken: "fake-token-def",
    me: { id: 3, email: "x", name: "x", companyId: 101, companyName: "Verify Portal Test Co", companyDomain: "x" },
  });
  assert(secondTenant.id !== tenant.id, `provisionSelfServeTenant: dedupes colliding slugs (got "${secondTenant.id}")`);

  // --- sessions --------------------------------------------------------
  const session = await db.session.create({ tenantId: tenant.id, ttlMs: 1000 * 60 });
  const found = await db.session.findValid(session.token);
  assert(!!found && found.tenantId === tenant.id, "session.create/findValid: round-trips a fresh session");

  const expiredSession = await db.session.create({ tenantId: tenant.id, ttlMs: -1000 });
  const shouldBeNull = await db.session.findValid(expiredSession.token);
  assert(shouldBeNull === null, "session.findValid: an already-expired session is treated as absent");

  await db.session.delete(session.token);
  const afterDelete = await db.session.findValid(session.token);
  assert(afterDelete === null, "session.delete: session can no longer be found after logout");

  // --- portal aggregate summary (pure function) ------------------------
  const idA = fixtureIdentity({ id: "idA", email: "a@example.com", lastSeenAt: new Date("2026-01-10") });
  const idB = fixtureIdentity({ id: "idB", email: "b@example.com", lastSeenAt: new Date("2026-01-12") });
  const idC = fixtureIdentity({ id: "idC", email: null, lastSeenAt: new Date("2026-01-05") }); // never identified — no touchpoints

  const tps: Touchpoint[] = [
    fixtureTouchpoint({ identityId: "idA", channel: "ad_click", source: "linkedin_ads", campaign: "Q1-launch", occurredAt: new Date("2026-01-01") }),
    fixtureTouchpoint({ identityId: "idA", channel: "website_visit", source: "website", occurredAt: new Date("2026-01-05") }),
    fixtureTouchpoint({ identityId: "idA", channel: "pipedrive_stage_change", source: "pipedrive", occurredAt: new Date("2026-01-10") }),
    fixtureTouchpoint({ identityId: "idB", channel: "email_click", source: "mailchimp", campaign: "Q1-launch", occurredAt: new Date("2026-01-08") }),
    fixtureTouchpoint({ identityId: "idB", channel: "website_visit", source: "website", occurredAt: new Date("2026-01-12") }),
  ];

  const summary = buildPortalSummary([idA, idB, idC], tps);
  assert(summary.totalIdentities === 3, "buildPortalSummary: counts every identity, including ones with no touchpoints yet");
  assert(summary.identifiedIdentities === 2, "buildPortalSummary: counts only identities with a known email as 'identified'");
  assert(summary.totalTouchpoints === 5, "buildPortalSummary: total touchpoint count matches input");
  assert(
    summary.firstTouchChannelCounts.find((c) => c.channel === "Ad click")?.count === 1,
    "buildPortalSummary: first-touch channel counts group correctly (idA's first touch was an ad click)"
  );
  assert(
    summary.lastTouchChannelCounts.find((c) => c.channel === "Deal stage")?.count === 1,
    "buildPortalSummary: last-touch channel counts group correctly (idA's last touch was a stage change)"
  );
  assert(
    summary.topCampaigns.find((c) => c.campaign === "Q1-launch")?.count === 2,
    "buildPortalSummary: campaign counts aggregate across identities (Q1-launch appears for both idA and idB)"
  );
  assert(summary.recent[0].identityId === "idB", "buildPortalSummary: recent list is sorted most-recently-seen first");
  assert(summary.recent.length === 2, "buildPortalSummary: recent list only includes identities that actually have touchpoints");

  const emptySummary = buildPortalSummary([], []);
  assert(emptySummary.totalIdentities === 0 && emptySummary.recent.length === 0, "buildPortalSummary: empty input doesn't throw, returns zeroed summary");

  // --- conversion / funnel / daily-volume additions ---------------------
  // Reuses idA/idB/tps from above, but marks idA as having converted to a
  // Deal (and having reached Lead stage first) so there's something
  // real to compute a non-trivial rate/funnel against. idA's first touch
  // (chronologically earliest touchpoint) is the linkedin_ads ad_click
  // with campaign "Q1-launch"; idB's first touch is the mailchimp
  // email_click, which also happens to carry campaign "Q1-launch" —
  // deliberately reusing the same campaign on both so campaignPerformance
  // has a real total>1 group to compute a rate against, the same way
  // topCampaigns' own test above relies on this fixture's overlap.
  const idAConverted = fixtureIdentity({
    id: "idA",
    email: "a@example.com",
    lastSeenAt: new Date("2026-01-10"),
    leadCreatedAt: new Date("2026-01-02"),
    leadCreatedLeadId: "lead-1",
    dealCreatedDealId: 501,
  });
  const convSummary = buildPortalSummary([idAConverted, idB, idC], tps);

  assert(
    convSummary.conversionBySource.find((c) => c.source === "linkedin_ads")?.total === 1 &&
      convSummary.conversionBySource.find((c) => c.source === "linkedin_ads")?.converted === 1 &&
      convSummary.conversionBySource.find((c) => c.source === "linkedin_ads")?.rate === 1,
    "conversionBySource: idA's first-touch source (linkedin_ads) shows 1/1 converted, rate 1"
  );
  assert(
    convSummary.conversionBySource.find((c) => c.source === "mailchimp")?.converted === 0 &&
      convSummary.conversionBySource.find((c) => c.source === "mailchimp")?.rate === 0,
    "conversionBySource: idB's first-touch source (mailchimp) shows 0 converted, rate 0 — never marked as having a Deal"
  );
  assert(
    convSummary.campaignPerformance.find((c) => c.campaign === "Q1-launch")?.total === 2 &&
      convSummary.campaignPerformance.find((c) => c.campaign === "Q1-launch")?.converted === 1 &&
      convSummary.campaignPerformance.find((c) => c.campaign === "Q1-launch")?.rate === 0.5,
    "campaignPerformance: Q1-launch grouped by first-touch campaign (both idA and idB) shows 1/2 converted, rate 0.5 — distinct from topCampaigns' touchpoint-count of 2 for the same label"
  );
  assert(
    convSummary.funnel.map((f) => f.stage).join(",") === "Total tracked,Identified,Lead created,Deal created,Won",
    "funnel: stages are in the expected fixed order"
  );
  assert(
    convSummary.funnel.find((f) => f.stage === "Total tracked")?.count === 3 &&
      convSummary.funnel.find((f) => f.stage === "Identified")?.count === 2 &&
      convSummary.funnel.find((f) => f.stage === "Lead created")?.count === 1 &&
      convSummary.funnel.find((f) => f.stage === "Deal created")?.count === 1 &&
      convSummary.funnel.find((f) => f.stage === "Won")?.count === 0,
    "funnel: counts narrow correctly at each stage (only idA reached Lead/Deal, nobody's Won yet)"
  );

  // --- revenue / time-to-convert (conversionBySource & campaignPerformance) ---
  // idA's first touch (linkedin_ads) was 2026-01-01; giving it a
  // dealCreatedAt 10 days later plus a Won deal with a real value lets
  // us check both new fields land in the same linkedin_ads row.
  const idAWithRevenue = fixtureIdentity({
    id: "idA",
    email: "a@example.com",
    lastSeenAt: new Date("2026-01-11"),
    dealCreatedDealId: 501,
    dealCreatedAt: new Date("2026-01-11"),
    dealValueAtCreate: 4500,
    dealCurrencyAtCreate: "GBP",
    wonDealId: 501,
    dealValue: 5000,
    dealCurrency: "GBP",
  });
  const revenueSummary = buildPortalSummary([idAWithRevenue, idB, idC], tps);
  const linkedinRow = revenueSummary.conversionBySource.find((c) => c.source === "linkedin_ads");
  assert(linkedinRow?.wonRevenue.GBP === 5000, "conversionBySource: wonRevenue is keyed by currency and only counts WON deals with a captured value");
  assert(linkedinRow?.avgDaysToConvert === 10, "conversionBySource: avgDaysToConvert is the gap between first touch (Jan 1) and dealCreatedAt (Jan 11) — exactly 10 days");
  assert(linkedinRow?.avgTouchpointsToWon === 3, "conversionBySource: avgTouchpointsToWon uses the identity's full touchpoint count as of now (idA has 3 touchpoints in the shared tps fixture) — only counted for WON identities");
  const mailchimpRow = revenueSummary.conversionBySource.find((c) => c.source === "mailchimp");
  assert(
    Object.keys(mailchimpRow?.wonRevenue ?? { x: 1 }).length === 0 && mailchimpRow?.avgDaysToConvert === null && mailchimpRow?.avgTouchpointsToWon === null,
    "conversionBySource: a source with no converted/won identities shows empty wonRevenue and null avgDaysToConvert/avgTouchpointsToWon, not 0 or NaN"
  );
  assert(
    revenueSummary.funnelValue.find((f) => f.stage === "Deal created")?.value.GBP === 4500,
    "funnelValue: 'Deal created' uses dealValueAtCreate (the early estimate, 4500) — a DIFFERENT number from the eventual Won value (5000), proving the two are tracked separately, not overwritten"
  );
  assert(
    revenueSummary.funnelValue.find((f) => f.stage === "Won")?.value.GBP === 5000,
    "funnelValue: 'Won' uses dealValue (the actual closed figure, 5000), not dealValueAtCreate's earlier estimate"
  );

  // --- conversionTrend -----------------------------------------------------
  const trendTp = fixtureTouchpoint({ identityId: "idA", channel: "ad_click", source: "linkedin_ads", occurredAt: new Date() });
  const trendIdentity = fixtureIdentity({ id: "idA", email: "a@example.com", dealCreatedDealId: 501 });
  const trendSummary = buildPortalSummary([trendIdentity], [trendTp]);
  assert(trendSummary.conversionTrend.length === 12, "conversionTrend: always returns exactly 12 zero-filled weeks");
  assert(
    trendSummary.conversionTrend.every((w, i) => i === 0 || trendSummary.conversionTrend[i - 1].weekStart < w.weekStart),
    "conversionTrend: weeks are in strictly ascending order"
  );
  const thisWeek = trendSummary.conversionTrend[trendSummary.conversionTrend.length - 1];
  assert(
    thisWeek.total === 1 && thisWeek.converted === 1 && thisWeek.rate === 1,
    "conversionTrend: a first touch occurring right now lands in the final (this week's) bucket, and reflects the identity's CURRENT converted state"
  );

  // --- segmentPerformance (multi-select: one identity counts in EACH of its segments) ---
  const multiSegmentIdentity = fixtureIdentity({
    id: "idA",
    email: "a@example.com",
    segmentValue: "12,45", // two Labels
    dealCreatedDealId: 801,
    wonDealId: 801,
    dealValue: 2000,
    dealCurrency: "USD",
  });
  const singleSegmentIdentity = fixtureIdentity({ id: "idB", email: "b@example.com", segmentValue: "45" });
  const segOptions = [
    { id: "12", name: "Villas" },
    { id: "45", name: "Apartments" },
  ];
  const segPerfSummary = buildPortalSummary([multiSegmentIdentity, singleSegmentIdentity, idC], tps, undefined, segOptions);
  const villasRow = segPerfSummary.segmentPerformance.find((s) => s.segmentId === "12");
  const apartmentsRow = segPerfSummary.segmentPerformance.find((s) => s.segmentId === "45");
  assert(
    villasRow?.segmentName === "Villas" && villasRow?.total === 1 && villasRow?.converted === 1 && villasRow?.wonRevenue.USD === 2000,
    "segmentPerformance: idA (segments '12,45') counts toward the 'Villas' (id 12) row, including its Won revenue"
  );
  assert(
    apartmentsRow?.total === 2,
    "segmentPerformance: 'Apartments' (id 45) total is 2 — both idA (multi-select, also in Villas) AND idB (single-select) count toward it, proving multi-select membership doesn't exclude an identity from other groups"
  );

  // --- assistedConversions (multi-touch: every channel in a Won journey, not just first/last) ---
  const assistTps = [
    fixtureTouchpoint({ identityId: "idA", channel: "ad_click", source: "google", occurredAt: new Date("2026-03-01") }),
    fixtureTouchpoint({ identityId: "idA", channel: "email_click", source: "mailchimp", occurredAt: new Date("2026-03-05") }),
    fixtureTouchpoint({ identityId: "idA", channel: "pipedrive_stage_change", source: "pipedrive", occurredAt: new Date("2026-03-10") }),
  ];
  const assistIdentity = fixtureIdentity({ id: "idA", email: "a@example.com", wonDealId: 900 });
  const notWonIdentity = fixtureIdentity({ id: "idB", email: "b@example.com" });
  const notWonTp = fixtureTouchpoint({ identityId: "idB", channel: "email_click", source: "mailchimp", occurredAt: new Date("2026-03-02") });
  const assistSummary = buildPortalSummary([assistIdentity, notWonIdentity], [...assistTps, notWonTp]);
  assert(
    assistSummary.assistedConversions.find((a) => a.channel === "Email click")?.wonCount === 1,
    "assistedConversions: 'Email click' counts for idA's Won journey even though it was the MIDDLE touch, not first or last — the whole point of this being a multi-touch view"
  );
  assert(
    assistSummary.assistedConversions.every((a) => a.channel !== "Email click" || a.wonRate === 1),
    "assistedConversions: wonRate is relative to total WON identities (1), not total identities (2) — idB never converted, so it shouldn't dilute the denominator"
  );

  // --- multiTouchAttribution (real revenue splitting, not just presence) ---
  const mtaWonAt = new Date("2026-03-20T00:00:00Z");
  const mtaTps = [
    fixtureTouchpoint({ identityId: "idA", channel: "ad_click", source: "google", occurredAt: new Date("2026-03-10T00:00:00Z") }), // 10 days before won
    fixtureTouchpoint({ identityId: "idA", channel: "email_click", source: "mailchimp", occurredAt: new Date("2026-03-15T00:00:00Z") }), // 5 days before won
    fixtureTouchpoint({ identityId: "idA", channel: "website_visit", source: "website", occurredAt: new Date("2026-03-18T00:00:00Z") }), // 2 days before won
    fixtureTouchpoint({ identityId: "idA", channel: "pipedrive_stage_change", source: "pipedrive", occurredAt: mtaWonAt }), // on the day it won
  ];
  const mtaIdentity = fixtureIdentity({ id: "idA", email: "a@example.com", wonDealId: 950, dealValue: 1000, dealCurrency: "USD", dealWonAt: mtaWonAt });
  const mtaSummary = buildPortalSummary([mtaIdentity], mtaTps);
  const mta = mtaSummary.multiTouchAttribution;

  function findRow(rows: typeof mta.linear, channel: string) {
    return rows.find((r) => r.channel === channel);
  }
  const linearSum = mta.linear.reduce((sum, r) => sum + (r.creditedRevenue.USD ?? 0), 0);
  assert(Math.round(linearSum) === 1000, "multiTouchAttribution.linear: credited revenue across all 4 channels sums to exactly the deal's value (1000), regardless of journey length");
  assert(
    Math.round((findRow(mta.linear, "Ad click")?.creditedRevenue.USD ?? 0)) === 250 &&
      Math.round((findRow(mta.linear, "Deal stage")?.creditedRevenue.USD ?? 0)) === 250,
    "multiTouchAttribution.linear: equal 1/4 credit (250) to every touchpoint regardless of position — first and last touch get the same as the middle ones"
  );

  const uShapedFirst = findRow(mta.uShaped, "Ad click")?.creditedRevenue.USD ?? 0;
  const uShapedLast = findRow(mta.uShaped, "Deal stage")?.creditedRevenue.USD ?? 0;
  const uShapedMiddle = findRow(mta.uShaped, "Email click")?.creditedRevenue.USD ?? 0;
  assert(
    Math.round(uShapedFirst) === 400 && Math.round(uShapedLast) === 400 && Math.round(uShapedMiddle) === 100,
    "multiTouchAttribution.uShaped: first/last touch get 40% each (400), the 2 middle touches split the remaining 20% evenly (100 each)"
  );

  const timeDecayFirst = findRow(mta.timeDecay, "Ad click")?.creditedRevenue.USD ?? 0;
  const timeDecayLast = findRow(mta.timeDecay, "Deal stage")?.creditedRevenue.USD ?? 0;
  const timeDecaySum = mta.timeDecay.reduce((sum, r) => sum + (r.creditedRevenue.USD ?? 0), 0);
  assert(
    timeDecayLast > timeDecayFirst && Math.round(timeDecaySum) === 1000,
    "multiTouchAttribution.timeDecay: the touchpoint closest to the win (Deal stage, day 0) gets MORE credit than the one furthest away (Ad click, 10 days prior), and the total still sums to exactly 1000"
  );

  const mtaNoValue = fixtureIdentity({ id: "idB", email: "b@example.com", wonDealId: 951, dealValue: null, dealCurrency: null });
  const mtaNoValueTp = fixtureTouchpoint({ identityId: "idB", channel: "ad_click", source: "google", occurredAt: new Date("2026-03-10") });
  const mtaNoValueSummary = buildPortalSummary([mtaNoValue], [mtaNoValueTp]);
  assert(
    mtaNoValueSummary.multiTouchAttribution.linear[0]?.creditedConversions === 1 &&
      Object.keys(mtaNoValueSummary.multiTouchAttribution.linear[0]?.creditedRevenue ?? {}).length === 0,
    "multiTouchAttribution: a Won deal with no captured value still contributes creditedConversions (1, the only touchpoint) but no revenue — no currency to attribute money in"
  );

  // --- notableChanges (week-over-week volume by source) -----------------
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const repeatTps = (source: string, count: number, dayOffset: number) =>
    Array.from({ length: count }, (_, i) =>
      fixtureTouchpoint({ identityId: "idA", channel: "website_visit", source, occurredAt: daysAgo(dayOffset + i * 0.1) })
    );
  const notableTps = [
    ...repeatTps("facebook", 10, 10), // last week: 10 touchpoints (well above the min baseline)
    ...repeatTps("facebook", 4, 2), // this week: 4 — a real, sizeable (60%) drop
    ...repeatTps("google", 5, 10), // last week: 5
    ...repeatTps("google", 5, 2), // this week: 5 — flat, should NOT be flagged
    ...repeatTps("tiktok", 2, 10), // last week: only 2 — below NOTABLE_CHANGE_MIN_BASELINE (3)
    ...repeatTps("tiktok", 10, 2), // this week: 10 — a huge % jump, but shouldn't be flagged (baseline too small to trust)
    ...repeatTps("bing", 10, 10), // last week: 10
    ...repeatTps("bing", 8, 2), // this week: 8 — only a 20% drop, below the 30% threshold
  ];
  const notableIdentity = fixtureIdentity({ id: "idA", email: "a@example.com" });
  const notableSummary = buildPortalSummary([notableIdentity], notableTps);
  const facebookChange = notableSummary.notableChanges.find((c) => c.text.startsWith("facebook"));
  assert(
    !!facebookChange && facebookChange.direction === "decrease" && facebookChange.text.includes("60%"),
    "notableChanges: facebook's real 60% week-over-week drop (10 → 4) is correctly flagged as a decrease"
  );
  assert(
    !notableSummary.notableChanges.some((c) => c.text.startsWith("google")),
    "notableChanges: google's flat volume (5 → 5, 0% change) is correctly NOT flagged"
  );
  assert(
    !notableSummary.notableChanges.some((c) => c.text.startsWith("tiktok")),
    "notableChanges: tiktok's huge-looking jump (2 → 10) is correctly NOT flagged — last week's baseline (2) is below the minimum sample size, so the % change isn't trustworthy"
  );
  assert(
    !notableSummary.notableChanges.some((c) => c.text.startsWith("bing")),
    "notableChanges: bing's real but modest 20% drop (10 → 8) is correctly NOT flagged — below the 30% notability threshold"
  );

  // --- computeNotableChanges rules 2-4: revenue concentration, low-conversion, attribution-quality trend ---
  const insightIdentities: Identity[] = [];
  const insightTps: Touchpoint[] = [];
  // "meta": 6 prospects, 0 deals — should trigger rule 3 (volume without deals)
  for (let i = 0; i < 6; i++) {
    const id = fixtureIdentity({ id: `metaId${i}`, email: `meta${i}@example.com` });
    insightIdentities.push(id);
    insightTps.push(fixtureTouchpoint({ identityId: id.id, channel: "ad_click", source: "meta", campaign: "c1", occurredAt: daysAgo(20) }));
  }
  // "referral": 5 prospects, one Won with a large value — 100% of Won revenue, should trigger rule 2 (strongest revenue source)
  for (let i = 0; i < 5; i++) {
    const won = i === 0;
    const id = fixtureIdentity({
      id: `refId${i}`,
      email: `ref${i}@example.com`,
      dealCreatedDealId: won ? 900 : null,
      wonDealId: won ? 900 : null,
      dealValue: won ? 100000 : null,
      dealCurrency: won ? "USD" : null,
    });
    insightIdentities.push(id);
    insightTps.push(fixtureTouchpoint({ identityId: id.id, channel: "ad_click", source: "referral", campaign: "c2", occurredAt: daysAgo(20) }));
  }
  // Attribution-quality trend: last week (real tracked touches, 0% missing) vs this week (3 of 5 are CRM-only, 60% missing) — a 60-point jump should trigger rule 4
  for (let i = 0; i < 5; i++) {
    const id = fixtureIdentity({ id: `lwId${i}`, email: `lw${i}@example.com` });
    insightIdentities.push(id);
    insightTps.push(fixtureTouchpoint({ identityId: id.id, channel: "website_visit", source: "website", referrer: "https://google.com", occurredAt: daysAgo(10) }));
  }
  for (let i = 0; i < 5; i++) {
    const missing = i < 3;
    const id = fixtureIdentity({ id: `twId${i}`, email: `tw${i}@example.com` });
    insightIdentities.push(id);
    insightTps.push(
      missing
        ? fixtureTouchpoint({ identityId: id.id, channel: "pipedrive_lead_created", source: "pipedrive", occurredAt: daysAgo(2) })
        : fixtureTouchpoint({ identityId: id.id, channel: "website_visit", source: "website", referrer: "https://google.com", occurredAt: daysAgo(2) })
    );
  }
  const insightSummary = buildPortalSummary(insightIdentities, insightTps);
  assert(
    insightSummary.notableChanges.some((c) => c.text.includes("referral is your strongest revenue source") && c.text.includes("100%")),
    "computeNotableChanges (rule 2): 'referral' correctly flagged as strongest revenue source — 100% of Won revenue, from a meaningful (5-prospect) sample, not a tiny one"
  );
  assert(
    insightSummary.notableChanges.some((c) => c.text.includes("meta is generating prospects but few deals") && c.text.includes("6 prospects")),
    "computeNotableChanges (rule 3): 'meta' correctly flagged — 6 prospects, 0 deals, well below the 10% conversion threshold"
  );
  assert(
    insightSummary.notableChanges.some((c) => c.text.startsWith("Attribution quality has dropped") && c.text.includes("60%") && c.text.includes("0%")),
    "computeNotableChanges (rule 4): a 60-point week-over-week jump in missing-attribution rate among newly-seen contacts is correctly flagged"
  );

  // --- dealStageBySource ("where do leads get stuck?") -------------------
  const openDealIdentity = fixtureIdentity({
    id: "idA",
    email: "a@example.com",
    dealCreatedDealId: 950,
    dealCurrentStageId: 20,
    dealCurrentStageName: "Negotiation",
  });
  const wonWithStageIdentity = fixtureIdentity({
    id: "idB",
    email: "b@example.com",
    dealCreatedDealId: 951,
    wonDealId: 951,
    dealCurrentStageId: 20,
    dealCurrentStageName: "Negotiation", // pre-win stage — should NOT count, since idB already exited the pipeline
  });
  const noStageYetIdentity = fixtureIdentity({ id: "idC", email: "c@example.com", dealCreatedDealId: 952 }); // has a Deal but no stage-change webhook has fired yet
  const stageSummary = buildPortalSummary([openDealIdentity, wonWithStageIdentity, noStageYetIdentity], tps);
  const linkedinStageRow = stageSummary.dealStageBySource.find((r) => r.source === "linkedin_ads");
  assert(
    linkedinStageRow?.stages.length === 1 && linkedinStageRow?.stages[0].stageName === "Negotiation" && linkedinStageRow?.stages[0].count === 1,
    "dealStageBySource: only idA (OPEN deal, has a current stage) counts — idB is excluded because it's already Won, idC excluded because it has no stage captured yet"
  );

  const recentTp = fixtureTouchpoint({ identityId: "idA", channel: "website_visit", occurredAt: new Date() });
  const dayVolumeSummary = buildPortalSummary([idAConverted, idB, idC], [...tps, recentTp]);
  assert(dayVolumeSummary.touchpointsByDay.length === 30, "touchpointsByDay: always returns exactly 30 zero-filled days, not just days with activity");
  assert(
    dayVolumeSummary.touchpointsByDay[29].count >= 1,
    "touchpointsByDay: a touchpoint occurring right now lands in the final (today's) bucket"
  );
  assert(
    dayVolumeSummary.touchpointsByDay.every((d, i) => i === 0 || dayVolumeSummary.touchpointsByDay[i - 1].date < d.date),
    "touchpointsByDay: days are in strictly ascending order"
  );
  assert(
    tps.every((tp) => dayVolumeSummary.touchpointsByDay.reduce((sum, d) => sum + d.count, 0) >= 1),
    "touchpointsByDay: the recent touchpoint is actually counted somewhere in the 30-day window"
  );

  // --- filterProspects (dashboard drill-down) ---------------------------
  const bySource = filterProspects([idAConverted, idB, idC], tps, { type: "source", value: "linkedin_ads" });
  assert(
    bySource.length === 1 && bySource[0].identityId === "idA",
    "filterProspects: filtering by source returns only the identity whose first touch matches, not both"
  );

  const byCampaign = filterProspects([idAConverted, idB, idC], tps, { type: "campaign", value: "Q1-launch" });
  assert(
    byCampaign.length === 2 && byCampaign[0].identityId === "idB" && byCampaign[1].identityId === "idA",
    "filterProspects: filtering by campaign returns both matching identities, sorted most-recently-seen first (same order as the default recent list)"
  );

  const byLeadFunnel = filterProspects([idAConverted, idB, idC], tps, { type: "funnel", value: "lead" });
  assert(
    byLeadFunnel.length === 1 && byLeadFunnel[0].identityId === "idA",
    "filterProspects: funnel filter 'lead' returns only the identity with leadCreatedAt set"
  );

  const byTotalFunnel = filterProspects([idAConverted, idB, idC], tps, { type: "funnel", value: "total" });
  assert(
    byTotalFunnel.length === 3 && byTotalFunnel.some((r) => r.identityId === "idC" && r.firstTouchChannel === "No tracked touch"),
    "filterProspects: funnel filter 'total' now correctly INCLUDES idC (zero touchpoints) too, shown with a clear 'No tracked touch' fallback rather than crashing or being silently dropped — toRecentProspect is null-safe now, so the drill-down's row count matches what matchingIdentities actually decided to include"
  );

  const identitiesBySource = filterIdentities([idAConverted, idB, idC], tps, { type: "source", value: "linkedin_ads" });
  assert(
    identitiesBySource.length === 1 && identitiesBySource[0].id === "idA",
    "filterIdentities: returns the raw Identity row (not a RecentProspect), for the CSV export route to feed into buildProspectsCsv"
  );

  // --- paginateProspects (Recently active prospects' real pagination) ---
  const page1 = paginateProspects([idAConverted, idB, idC], tps, { includeAnonymous: true, page: 1, pageSize: 1 });
  assert(
    page1.total === 3 && page1.prospects.length === 1,
    "paginateProspects: total reflects every matching prospect (3) — idC (zero touchpoints) is now correctly included too, not silently dropped — even though pageSize only returns 1 of them"
  );
  assert(page1.prospects[0].identityId === "idB", "paginateProspects: page 1 returns the most-recently-seen match first (idB, lastSeenAt 01-12), same sort order as the old capped `recent` list");
  const page2 = paginateProspects([idAConverted, idB, idC], tps, { includeAnonymous: true, page: 2, pageSize: 1 });
  assert(page2.prospects.length === 1 && page2.prospects[0].identityId === "idA", "paginateProspects: page 2 returns the next match (idA), not a repeat of page 1");
  const pastLastPage = paginateProspects([idAConverted, idB, idC], tps, { includeAnonymous: true, page: 5, pageSize: 1 });
  assert(pastLastPage.prospects.length === 0 && pastLastPage.total === 3, "paginateProspects: requesting a page past the end returns an empty page, not an error, while total stays accurate");

  // --- UTM filter (segments every report, not just the drill-down) ------
  const utmFilteredSummary = buildPortalSummary([idAConverted, idB, idC], tps, { source: "linkedin_ads" });
  assert(
    utmFilteredSummary.totalIdentities === 1 && utmFilteredSummary.identifiedIdentities === 1,
    "buildPortalSummary: an active UTM filter narrows totalIdentities/identifiedIdentities to just the matching cohort (idA), not the whole tenant"
  );
  assert(
    utmFilteredSummary.funnel.find((f) => f.stage === "Total tracked")?.count === 1,
    "buildPortalSummary: the funnel's own 'Total tracked' stage reflects the UTM-filtered cohort too, not the unfiltered total"
  );
  assert(
    utmFilteredSummary.recent.length === 1 && utmFilteredSummary.recent[0].identityId === "idA",
    "buildPortalSummary: recent list is restricted to the UTM-matching cohort"
  );
  assert(
    utmFilteredSummary.distinctUtmValues.sources.includes("mailchimp"),
    "buildPortalSummary: distinctUtmValues always reflects the FULL unfiltered data (includes idB's source even though idB itself was filtered out of every other field)"
  );

  const unfilteredSummary = buildPortalSummary([idAConverted, idB, idC], tps);
  assert(
    unfilteredSummary.totalIdentities === 3,
    "buildPortalSummary: with no utmFilter argument at all, totalIdentities is unchanged from before this feature existed (backward compatible)"
  );

  const utmFilteredBySource = filterProspects([idAConverted, idB, idC], tps, { type: "funnel", value: "total" }, { source: "linkedin_ads" });
  assert(
    utmFilteredBySource.length === 1 && utmFilteredBySource[0].identityId === "idA",
    "filterProspects: a UTM filter composes with a ProspectFilter (funnel/source/campaign click) — both apply together, not either/or"
  );

  // --- segment filter (Pipedrive Label or any configured field) --------
  const idAWithSegment = fixtureIdentity({ id: "idA", email: "a@example.com", segmentValue: "12,45" }); // multi-select: two labels
  const idBWithSegment = fixtureIdentity({ id: "idB", email: "b@example.com", lastSeenAt: new Date("2026-01-12"), segmentValue: "7" });
  const segmentOptions = [
    { id: "12", name: "Product A" },
    { id: "45", name: "Product B" },
    { id: "7", name: "Product C" },
  ];
  const segmentFilteredSummary = buildPortalSummary([idAWithSegment, idBWithSegment, idC], tps, { segment: "12" }, segmentOptions);
  assert(
    segmentFilteredSummary.totalIdentities === 1 && segmentFilteredSummary.recent[0]?.identityId === "idA",
    "buildPortalSummary: filtering by segment '12' matches idA (whose segmentValue is the multi-select list '12,45'), not idB — membership check, not exact string match"
  );
  assert(
    segmentFilteredSummary.distinctUtmValues.segments.find((s) => s.id === "12")?.name === "Product A",
    "distinctUtmValues.segments: resolves the raw Pipedrive option ID to its readable name via the passed segmentOptions"
  );
  const unfilteredSegmentSummary = buildPortalSummary([idAWithSegment, idBWithSegment, idC], tps, undefined, segmentOptions);
  assert(
    unfilteredSegmentSummary.recent.find((r) => r.identityId === "idA")?.segmentLabel === "Product A, Product B",
    "toRecentProspect: segmentLabel resolves EVERY id in a multi-select value and joins them, not just the first"
  );

  // --- channel filter (first-touch channel, e.g. "Ad click") ------------
  const channelFilteredSummary = buildPortalSummary([idAConverted, idB, idC], tps, { channel: "Ad click" });
  assert(
    channelFilteredSummary.totalIdentities === 1 && channelFilteredSummary.recent[0]?.identityId === "idA",
    "buildPortalSummary: filtering by channel 'Ad click' matches idA (first touch is ad_click) — idB's first touch is email_click, correctly excluded"
  );
  assert(
    channelFilteredSummary.distinctUtmValues.channels.includes("Email click"),
    "distinctUtmValues.channels: reflects the FULL unfiltered data, same convention as sources/segments above — includes idB's channel even though idB itself was filtered out"
  );
  const channelFilteredBySource = filterProspects([idAConverted, idB, idC], tps, { type: "funnel", value: "total" }, { channel: "Ad click", source: "linkedin_ads" });
  assert(
    channelFilteredBySource.length === 1 && channelFilteredBySource[0].identityId === "idA",
    "filterProspects: channel composes with the other UTM fields (source here) — both must match, not either/or"
  );

  // --- Acquisition fields & attribution status (RecentProspect) ---------
  const acqCrmOnlyTps = [
    fixtureTouchpoint({ identityId: "idA", channel: "pipedrive_lead_created", source: "pipedrive", occurredAt: new Date("2026-04-01") }),
    fixtureTouchpoint({ identityId: "idA", channel: "pipedrive_activity", source: "whatsapp_chat", occurredAt: new Date("2026-04-02") }),
  ];
  const acqCrmOnlyIdentity = fixtureIdentity({ id: "idA", email: "a@example.com" });
  const acqMissingSummary = buildPortalSummary([acqCrmOnlyIdentity], acqCrmOnlyTps);
  const acqMissingRow = acqMissingSummary.recent.find((r) => r.identityId === "idA");
  assert(
    acqMissingRow?.attributionStatus === "missing" && acqMissingRow?.acquisitionChannel === null,
    "toRecentProspect: an identity with ONLY CRM-event touchpoints (Lead created, a WhatsApp Activity) gets attributionStatus 'missing' and a null acquisitionChannel — even though firstTouchChannel (the OLD, still-used-elsewhere field) would show 'Lead created'"
  );
  assert(
    acqMissingRow?.firstTouchChannel === "Lead created",
    "toRecentProspect: firstTouchChannel is UNCHANGED (still whatever happened first, CRM events included) — acquisitionChannel is a deliberately separate, additive concept, not a replacement"
  );

  const acqMixedTps = [
    fixtureTouchpoint({ identityId: "idB", channel: "pipedrive_lead_created", source: "pipedrive", occurredAt: new Date("2026-04-01") }),
    fixtureTouchpoint({
      identityId: "idB",
      channel: "ad_click",
      source: "google",
      campaign: "spring_sale",
      gclid: "abc123",
      occurredAt: new Date("2026-04-02"),
    }),
  ];
  const acqMixedIdentity = fixtureIdentity({ id: "idB", email: "b@example.com" });
  const acqMixedSummary = buildPortalSummary([acqMixedIdentity], acqMixedTps);
  const acqMixedRow = acqMixedSummary.recent.find((r) => r.identityId === "idB");
  assert(
    acqMixedRow?.acquisitionChannel === "Ad click" && acqMixedRow?.attributionStatus === "attributed",
    "toRecentProspect: acquisitionChannel correctly skips PAST the chronologically-first CRM event (Lead created) to find the first REAL marketing touch (Ad click, with a campaign+gclid) — 'attributed' since it carries real campaign/click-id data"
  );

  const acqFallbackTps = [
    fixtureTouchpoint({
      identityId: "idC",
      channel: "lead_source_field",
      source: "https://www.instagram.com/p/DcJOBtlgfqT",
      campaign: null,
      occurredAt: new Date("2026-04-01"),
    }),
  ];
  const acqFallbackIdentity = fixtureIdentity({ id: "idC", email: "c@example.com" });
  const acqFallbackSummary = buildPortalSummary([acqFallbackIdentity], acqFallbackTps);
  const acqFallbackRow = acqFallbackSummary.recent.find((r) => r.identityId === "idC");
  assert(
    acqFallbackRow?.attributionStatus === "partial",
    "toRecentProspect: a lead_source_field touchpoint is ALWAYS 'partial', never 'attributed' — it's a best-effort fallback guess, not real tracking, even without a campaign check"
  );
  assert(
    acqFallbackRow?.acquisitionSource === "Instagram" && acqFallbackRow?.acquisitionSourceRaw === "https://www.instagram.com/p/DcJOBtlgfqT",
    "toRecentProspect: acquisitionSource normalizes a recognized platform URL to a clean name for display, while acquisitionSourceRaw keeps the original URL intact"
  );

  const acqDirectTps = [fixtureTouchpoint({ identityId: "idA", channel: "website_visit", source: "website", referrer: null, occurredAt: new Date("2026-04-01") })];
  const acqDirectIdentity = fixtureIdentity({ id: "idA", email: "a2@example.com" });
  const acqDirectSummary = buildPortalSummary([acqDirectIdentity], acqDirectTps);
  assert(
    acqDirectSummary.recent[0]?.attributionStatus === "direct",
    "toRecentProspect: a plain website_visit with no referrer at all is genuine direct traffic ('direct'), not a tracking gap ('partial')"
  );

  const acqStatusIdentity = fixtureIdentity({ id: "idA", email: "a3@example.com", dealCreatedDealId: 999 });
  const acqStatusSummary = buildPortalSummary(
    [acqStatusIdentity],
    [fixtureTouchpoint({ identityId: "idA", channel: "website_visit", occurredAt: new Date() })]
  );
  assert(acqStatusSummary.recent[0]?.status === "deal", "toRecentProspect: status collapses the existing lead/deal/won milestones into one glance-able value — has a Deal but no wonDealId, so 'deal' not 'lead' or 'won'");

  // --- Top-level commercial metrics (attributedLeadsCount, pipelineValue, wonRevenue, attributionCoverage) ---
  const topAttributedLead = fixtureIdentity({ id: "idA", email: "a@example.com", leadCreatedAt: new Date("2026-05-01"), dealCreatedDealId: 800, dealValueAtCreate: 5000, dealCurrencyAtCreate: "USD" });
  const topAttributedLeadTp = fixtureTouchpoint({ identityId: "idA", channel: "ad_click", source: "google", campaign: "spring", occurredAt: new Date("2026-05-01") });
  const topPartialLead = fixtureIdentity({ id: "idB", email: "b@example.com", leadCreatedAt: new Date("2026-05-02") });
  const topPartialLeadTp = fixtureTouchpoint({ identityId: "idB", channel: "social_organic", source: "instagram", occurredAt: new Date("2026-05-02") });
  const topWonIdentity = fixtureIdentity({ id: "idC", email: "c@example.com", wonDealId: 801, dealValue: 20000, dealCurrency: "USD" });
  const topWonTp = fixtureTouchpoint({ identityId: "idC", channel: "ad_click", source: "google", campaign: "spring", occurredAt: new Date("2026-05-03") });
  const topSummary = buildPortalSummary([topAttributedLead, topPartialLead, topWonIdentity], [topAttributedLeadTp, topPartialLeadTp, topWonTp]);
  assert(topSummary.attributedLeadsCount === 1, "attributedLeadsCount: only idA counts — a real Lead (leadCreatedAt set) AND attributionStatus 'attributed'. idB is a Lead but only 'partial' (organic, no campaign), so it's correctly excluded");
  assert(topSummary.pipelineValue.USD === 5000, "pipelineValue: idA's OPEN deal (dealCreatedDealId set, not yet won) contributes its dealValueAtCreate — idC's WON deal correctly does NOT show up here even though it also has a captured value");
  assert(topSummary.wonRevenue.USD === 20000, "wonRevenue: idC's actual closed dealValue, matching the existing funnelValue 'Won' figure");
  assert(
    topSummary.attributionCoverage.covered === 3 && topSummary.attributionCoverage.total === 3,
    "attributionCoverage: ALL 3 identities count as 'covered' — idA and idC are strictly 'attributed', and idB (partial, from organic social) STILL counts here too, since coverage means 'we know something meaningful,' not strictly 'a full UTM campaign' — that stricter distinction lives in attributionBreakdown instead"
  );
  assert(topSummary.attributionIssuesCount === 1, "attributionIssuesCount: only idB (partial) counts — 'attributed' identities are obviously not issues, and there are no 'missing' identities in this scenario");

  // --- attributionIssue drill-down filter (the "N tracking issues" popup) ---
  const zeroTouchpointIdentity = fixtureIdentity({ id: "idD", email: "d@example.com" }); // no touchpoints at all — exactly what "missing" attribution means
  const issueFiltered = filterProspects([topAttributedLead, topPartialLead, topWonIdentity, zeroTouchpointIdentity], [topAttributedLeadTp, topPartialLeadTp, topWonTp], {
    type: "attributionIssue",
    value: "true",
  });
  assert(
    issueFiltered.length === 2 && issueFiltered.some((r) => r.identityId === "idB") && issueFiltered.some((r) => r.identityId === "idD"),
    "attributionIssue filter: correctly includes idD (ZERO touchpoints, no summary at all) alongside idB (partial) — a zero-touchpoint identity is exactly what 'missing' means and must not be silently excluded by the general 'no summary, skip' guard other filter types rely on"
  );

  // --- attributionStatus filter (individual bucket drill-down, Attribution Health) ---
  const missingOnlyFiltered = filterProspects([topAttributedLead, topPartialLead, topWonIdentity, zeroTouchpointIdentity], [topAttributedLeadTp, topPartialLeadTp, topWonTp], {
    type: "attributionStatus",
    value: "missing",
  });
  assert(
    missingOnlyFiltered.length === 1 && missingOnlyFiltered[0].identityId === "idD",
    "attributionStatus filter (value='missing'): a STRICT single-status match — only idD, NOT idB (which is 'partial', a different bucket entirely, unlike the combined attributionIssue filter above)"
  );

  // --- attributionBreakdown (Attribution Health section) --------------------
  assert(
    topSummary.attributionBreakdown.attributed === 2 &&
      topSummary.attributionBreakdown.partial === 1 &&
      topSummary.attributionBreakdown.direct === 0 &&
      topSummary.attributionBreakdown.missing === 0 &&
      topSummary.attributionBreakdown.total === 3,
    "attributionBreakdown: all 4 buckets counted individually across the same 3-identity scenario used for attributionCoverage above (2 attributed, 1 partial, 0 direct, 0 missing)"
  );
  assert(
    topSummary.attributionBreakdown.score === 83,
    "attributionBreakdown.score: weighted average — (2 attributed × 1.0 + 1 partial × 0.5) / 3 × 100 = 83, not a simple attributed/total percentage (which would be 67)"
  );

  // --- CSV export (uncapped — unlike buildPortalSummary's top 25/10) ---
  const prospectsCsv = buildProspectsCsv([idA, idB, idC], tps);
  const prospectsLines = prospectsCsv.trim().split("\r\n");
  assert(
    prospectsLines[0] ===
      [
        "Contact",
        "First touch channel",
        "First touch source",
        "First touch medium",
        "First touch campaign",
        "First touch term",
        "First touch content",
        "First touch date",
        "First touch referrer",
        "First touch landing page",
        "First touch GCLID",
        "First touch FBCLID",
        "First touch MSCLKID",
        "Last touch channel",
        "Last touch source",
        "Last touch medium",
        "Last touch campaign",
        "Last touch term",
        "Last touch content",
        "Last touch date",
        "Last touch referrer",
        "Last touch landing page",
        "Last touch GCLID",
        "Last touch FBCLID",
        "Last touch MSCLKID",
        "Total touchpoints",
        "Touchpoints: Lead to Deal",
        "Touchpoints: Deal to Won",
        "First seen",
        "Last seen",
        "Pipedrive person ID",
        "Pipedrive URL",
        "Segment",
        "Deal value",
        "Deal currency",
      ].join(","),
    "buildProspectsCsv: header row matches expected columns — now including medium/term/content/referrer/landing page/click IDs for both first and last touch, the deal-lifecycle milestones, and a Pipedrive URL, not just the original handful of fields"
  );
  assert(prospectsLines.length === 3, "buildProspectsCsv: one row per identity that has touchpoints (idC has none, so excluded — same rule as buildPortalSummary's recent list)");
  assert(prospectsLines[1].startsWith("b@example.com,"), "buildProspectsCsv: sorted most-recently-seen first, same order as the dashboard table");
  assert(prospectsLines[2].startsWith("a@example.com,"), "buildProspectsCsv: second row is the earlier-seen identity");

  const anonCsv = buildProspectsCsv([fixtureIdentity({ id: "idD", email: null, lastSeenAt: new Date("2026-01-15") })], [
    fixtureTouchpoint({ identityId: "idD", channel: "website_visit", occurredAt: new Date("2026-01-15") }),
  ]);
  assert(anonCsv.includes("(anonymous),"), "buildProspectsCsv: an identity with no email exports as '(anonymous)', not a blank cell");

  // --- phone/name-only identification (no email) -------------------------
  const phoneOnlyIdentity = fixtureIdentity({
    id: "idF",
    email: null,
    name: "Jason Smith",
    phone: "+44 7700 900123",
    lastSeenAt: new Date("2026-01-17"),
  });
  const phoneOnlyTp = fixtureTouchpoint({ identityId: "idF", channel: "pipedrive_activity", source: "pipedrive", occurredAt: new Date("2026-01-17") });

  const phoneOnlyCsv = buildProspectsCsv([phoneOnlyIdentity], [phoneOnlyTp]);
  assert(
    phoneOnlyCsv.includes("Jason Smith,"),
    "buildProspectsCsv: a phone-only lead's Contact cell shows their captured name, not '(anonymous)', even with no email"
  );

  const noNamePhoneOnlyCsv = buildProspectsCsv(
    [fixtureIdentity({ id: "idG", email: null, name: null, phone: "+44 7700 900456", lastSeenAt: new Date("2026-01-17") })],
    [fixtureTouchpoint({ identityId: "idG", channel: "pipedrive_activity", occurredAt: new Date("2026-01-17") })]
  );
  assert(
    noNamePhoneOnlyCsv.includes("+44 7700 900456,"),
    "buildProspectsCsv: falls back to phone when name is also unknown, still not '(anonymous)'"
  );

  const phoneOnlyExcludedCsv = buildProspectsCsv([phoneOnlyIdentity], [phoneOnlyTp], null, false);
  assert(
    phoneOnlyExcludedCsv.includes("Jason Smith"),
    "buildProspectsCsv: includeAnonymous=false does NOT exclude a phone/name-only lead — that's the whole point of isIdentified() treating name/phone as identification, same as email"
  );

  const injectionCsv = buildProspectsCsv(
    [fixtureIdentity({ id: "idE", email: "=cmd|' /C calc'!A0", lastSeenAt: new Date("2026-01-16") })],
    [fixtureTouchpoint({ identityId: "idE", channel: "website_visit", occurredAt: new Date("2026-01-16") })]
  );
  assert(
    injectionCsv.includes("\"'=cmd") || injectionCsv.includes("'=cmd"),
    "buildProspectsCsv: a value starting with '=' is prefixed with an apostrophe, so Excel/Sheets never evaluates it as a formula"
  );

  // --- CSV export: medium/term/content/referrer/click IDs, deal-lifecycle milestones, and the Pipedrive URL all actually reach the row ---
  const idF = fixtureIdentity({
    id: "idF",
    email: "f@example.com",
    lastSeenAt: new Date("2026-01-20"),
    pipedrivePersonId: 4242,
    leadToDealTouchpoints: 5,
    dealToWonTouchpoints: 3,
  });
  const fullDetailCsv = buildProspectsCsv(
    [idF],
    [
      fixtureTouchpoint({
        identityId: "idF",
        channel: "ad_click",
        source: "google_ads",
        medium: "cpc",
        campaign: "Q1-launch",
        term: "pipedrive consultant",
        content: "ad-a",
        referrer: "https://www.google.com/",
        url: "https://example.com/landing",
        gclid: "gclid-123",
        occurredAt: new Date("2026-01-20"),
      }),
    ],
    "verify-co" // companyDomain
  );
  const fullDetailLine = fullDetailCsv.trim().split("\r\n")[1];
  assert(fullDetailLine.includes("cpc,"), "buildProspectsCsv: First touch medium reaches the row");
  assert(fullDetailLine.includes("pipedrive consultant,"), "buildProspectsCsv: First touch term reaches the row");
  assert(fullDetailLine.includes("ad-a,"), "buildProspectsCsv: First touch content reaches the row");
  assert(fullDetailLine.includes("gclid-123,"), "buildProspectsCsv: First touch GCLID reaches the row");
  assert(fullDetailLine.includes(",5,3,"), "buildProspectsCsv: both deal-lifecycle milestone counts (Lead to Deal, Deal to Won) reach the row, in order");
  assert(
    fullDetailLine.includes("https://verify-co.pipedrive.com/person/4242"),
    "buildProspectsCsv: Pipedrive URL is built from the companyDomain argument, same deep link the dashboard's Pipedrive column uses"
  );

  const noMilestonesCsv = buildProspectsCsv(
    [fixtureIdentity({ id: "idG", email: "g@example.com", lastSeenAt: new Date("2026-01-21") })],
    [fixtureTouchpoint({ identityId: "idG", channel: "website_visit", occurredAt: new Date("2026-01-21") })]
  );
  const noMilestonesLine = noMilestonesCsv.trim().split("\r\n")[1];
  assert(
    noMilestonesLine.includes(",1,,,"),
    "buildProspectsCsv: an identity with no deal-lifecycle milestones yet exports blank cells there, not '0' or 'null'"
  );

  const campaignsCsv = buildCampaignsCsv(tps);
  const campaignsLines = campaignsCsv.trim().split("\r\n");
  assert(campaignsLines[0] === "Campaign,Touchpoints", "buildCampaignsCsv: header row matches expected columns");
  assert(campaignsLines[1] === "Q1-launch,2", "buildCampaignsCsv: counts campaigns across every identity, uncapped (unlike buildPortalSummary's top 10)");

  assert(buildCampaignsCsv([]).trim() === "Campaign,Touchpoints", "buildCampaignsCsv: empty input still returns a valid header-only CSV");

  // --- buildGoogleAdsConversionsCsv --------------------------------------
  const gclidIdentity = fixtureIdentity({
    id: "idH",
    email: "gclid@example.com",
    dealCreatedDealId: 701,
    dealCreatedAt: new Date("2026-02-01T10:00:00Z"),
    wonDealId: 701,
    dealWonAt: new Date("2026-02-15T14:30:05Z"),
  });
  const gclidTp = fixtureTouchpoint({ identityId: "idH", channel: "ad_click", source: "google", gclid: "Cj0KCQjw_test_gclid" });

  const noGclidIdentity = fixtureIdentity({ id: "idI", email: "nogclid@example.com", dealCreatedDealId: 702, dealCreatedAt: new Date("2026-02-01") });
  const noGclidTp = fixtureTouchpoint({ identityId: "idI", channel: "website_visit", source: "website" });

  const noDealIdentity = fixtureIdentity({ id: "idJ", email: "nodeal@example.com" });
  const noDealTp = fixtureTouchpoint({ identityId: "idJ", channel: "ad_click", source: "google", gclid: "Cj0K_another_gclid" });

  const gAdsCsv = buildGoogleAdsConversionsCsv([gclidIdentity, noGclidIdentity, noDealIdentity], [gclidTp, noGclidTp, noDealTp]);
  const gAdsLines = gAdsCsv.trim().split("\r\n");
  assert(
    gAdsLines[0] === "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Currency Code",
    "buildGoogleAdsConversionsCsv: header row matches Google's documented 5-column format"
  );
  assert(gAdsLines.length === 3, "buildGoogleAdsConversionsCsv: 2 data rows for idH (Created + Won) + header = 3 lines total — idI (no gclid) and idJ (no deal) produce nothing");
  assert(
    gAdsLines.some((l) => l.startsWith("Cj0KCQjw_test_gclid,CRM Deal Created,2026-02-01 10:00:00 +0000")),
    "buildGoogleAdsConversionsCsv: Deal Created row uses dealCreatedAt, formatted yyyy-MM-dd HH:mm:ss +0000"
  );
  assert(
    gAdsLines.some((l) => l.startsWith("Cj0KCQjw_test_gclid,CRM Deal Won,2026-02-15 14:30:05 +0000")),
    "buildGoogleAdsConversionsCsv: Deal Won row uses dealWonAt (the timestamp this feature specifically started persisting), not dealCreatedAt or lastSeenAt"
  );
  assert(gAdsCsv.includes(",,"), "buildGoogleAdsConversionsCsv: Conversion Value and Currency Code are blank when the underlying value wasn't captured, not '0' or 'undefined'");

  const gclidWithValueIdentity = fixtureIdentity({
    id: "idK",
    email: "value@example.com",
    dealCreatedDealId: 703,
    dealCreatedAt: new Date("2026-02-01T10:00:00Z"),
    dealValueAtCreate: 4500,
    dealCurrencyAtCreate: "GBP",
    wonDealId: 703,
    dealWonAt: new Date("2026-02-15T14:30:05Z"),
    dealValue: 5000,
    dealCurrency: "GBP",
  });
  const gclidWithValueTp = fixtureTouchpoint({ identityId: "idK", channel: "ad_click", source: "google", gclid: "Cj0K_value_gclid" });
  const gAdsValueCsv = buildGoogleAdsConversionsCsv([gclidWithValueIdentity], [gclidWithValueTp]);
  assert(
    gAdsValueCsv.includes("Cj0K_value_gclid,CRM Deal Created,2026-02-01 10:00:00 +0000,4500,GBP"),
    "buildGoogleAdsConversionsCsv: Deal Created row now includes dealValueAtCreate/dealCurrencyAtCreate when captured"
  );
  assert(
    gAdsValueCsv.includes("Cj0K_value_gclid,CRM Deal Won,2026-02-15 14:30:05 +0000,5000,GBP"),
    "buildGoogleAdsConversionsCsv: Deal Won row uses the final dealValue/dealCurrency (5000), not the earlier dealValueAtCreate estimate (4500)"
  );

  // --- buildMicrosoftAdsConversionsCsv (msclkid, not gclid) ---------------
  const msclkidIdentity = fixtureIdentity({
    id: "idL",
    email: "msclkid@example.com",
    dealCreatedDealId: 704,
    dealCreatedAt: new Date("2026-02-01T18:50:54Z"),
    wonDealId: 704,
    dealWonAt: new Date("2026-02-15T06:05:03Z"), // 6:05:03 AM UTC — checks the AM/PM + no-leading-zero-hour formatting
  });
  const msclkidTp = fixtureTouchpoint({ identityId: "idL", channel: "ad_click", source: "bing_ads", msclkid: "f894f652ea334e739002f7167ab8f8e3" });
  const msAdsCsv = buildMicrosoftAdsConversionsCsv([msclkidIdentity, gclidIdentity], [msclkidTp, gclidTp]);
  const msAdsLines = msAdsCsv.trim().split("\r\n");
  assert(
    msAdsLines[0] === "Microsoft Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency",
    "buildMicrosoftAdsConversionsCsv: header uses 'Microsoft Click ID' and 'Conversion Currency' (not Google's 'Google Click ID'/'Currency Code')"
  );
  assert(
    msAdsLines.length === 3,
    "buildMicrosoftAdsConversionsCsv: only msclkidIdentity's 2 rows — gclidIdentity has no MSCLKID, so it's correctly excluded even though it has a GCLID"
  );
  assert(
    msAdsCsv.includes("f894f652ea334e739002f7167ab8f8e3,CRM Deal Created,2/1/2026 6:50:54 PM"),
    "buildMicrosoftAdsConversionsCsv: Conversion Time is M/D/YYYY h:mm:ss AM/PM with no leading zeros, matching Microsoft's own documented example format"
  );
  assert(
    msAdsCsv.includes("f894f652ea334e739002f7167ab8f8e3,CRM Deal Won,2/15/2026 6:05:03 AM"),
    "buildMicrosoftAdsConversionsCsv: hour 6 stays '6' (not '06') and correctly shows AM for a pre-noon UTC time"
  );

  // --- buildLinkedInAdsConversionsCsv (hashed email, not click ID alone) --
  const liIdentity = fixtureIdentity({
    id: "idM",
    email: "  LinkedIn.Test@Example.com  ", // deliberately messy casing/whitespace to check normalization before hashing
    dealCreatedDealId: 705,
    dealCreatedAt: new Date("2026-02-01T10:00:00Z"),
    wonDealId: 705,
    dealWonAt: new Date("2026-02-15T14:30:05Z"),
    dealValue: 3000,
    dealCurrency: "USD",
  });
  const liTp = fixtureTouchpoint({ identityId: "idM", channel: "ad_click", source: "linkedin_ads", liFatId: "li_test_fat_id_123" });
  const noEmailIdentity = fixtureIdentity({ id: "idN", email: null, dealCreatedDealId: 706, dealCreatedAt: new Date("2026-02-01") });
  const noEmailTp = fixtureTouchpoint({ identityId: "idN", channel: "ad_click", source: "linkedin_ads", liFatId: "li_should_be_excluded" });

  const liCsv = buildLinkedInAdsConversionsCsv([liIdentity, noEmailIdentity], [liTp, noEmailTp]);
  const liLines = liCsv.trim().split("\r\n");
  assert(
    liLines[0] === "Hashed Email (SHA-256),LinkedIn Click ID,Conversion Name,Conversion Time,Conversion Value,Currency Code",
    "buildLinkedInAdsConversionsCsv: header matches the documented shape (hashed email is the primary identifier, not the click ID alone)"
  );
  assert(liLines.length === 3, "buildLinkedInAdsConversionsCsv: noEmailIdentity is excluded entirely (no email = nothing LinkedIn could match), even though it has a li_fat_id");
  const expectedHash = require("crypto").createHash("sha256").update("linkedin.test@example.com").digest("hex");
  assert(
    liCsv.includes(expectedHash + ",li_test_fat_id_123,CRM Deal Created"),
    "buildLinkedInAdsConversionsCsv: email is lowercased and trimmed before hashing, so messy casing/whitespace still produces the correct, consistent hash"
  );
  assert(liCsv.includes(",CRM Deal Won,2026-02-15 14:30:05 +0000,3000,USD"), "buildLinkedInAdsConversionsCsv: Deal Won row includes the real captured value/currency, same as the other two ad exports");

  // --- cleanup -----------------------------------------------------
  await db.tenant.delete(tenant.id);
  await db.tenant.delete(secondTenant.id);

  console.log("\n✅ All portal logic checks passed.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
