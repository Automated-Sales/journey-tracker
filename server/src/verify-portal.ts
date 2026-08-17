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
import { buildPortalSummary, filterProspects, filterIdentities } from "./lib/portal-summary";
import { buildProspectsCsv, buildCampaignsCsv } from "./lib/csv";
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
    byTotalFunnel.length === 2,
    "filterProspects: funnel filter 'total' still excludes identities with zero touchpoints (idC) — there's no journey to show for them, same exclusion rule buildPortalSummary's own recent list already applies"
  );

  const identitiesBySource = filterIdentities([idAConverted, idB, idC], tps, { type: "source", value: "linkedin_ads" });
  assert(
    identitiesBySource.length === 1 && identitiesBySource[0].id === "idA",
    "filterIdentities: returns the raw Identity row (not a RecentProspect), for the CSV export route to feed into buildProspectsCsv"
  );

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

  // --- cleanup -----------------------------------------------------
  await db.tenant.delete(tenant.id);
  await db.tenant.delete(secondTenant.id);

  console.log("\n✅ All portal logic checks passed.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
