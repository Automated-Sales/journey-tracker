/**
 * Exercises the portal's session/auth HTTP surface against a REAL running
 * server (unlike verify-portal.ts, which only calls the functions
 * directly in-process). Split into three explicit modes rather than one
 * script, because of this project's one real known limitation (see
 * README "Known limitation"): sql.js loads the whole DB into memory once
 * per process, so a tenant inserted by a second process (this script)
 * while the dev server is already running would be invisible to that
 * server until it restarts. Fighting that instead of working with it:
 *
 *   1. `--seed`    (server STOPPED) — creates two test tenants (one exempt
 *                  from billing, one left 'incomplete' to exercise the
 *                  billing gate), writes their credentials to a fixture
 *                  file.
 *      (start the server now, so it loads the tenants `--seed` just wrote)
 *   2. `--run`     (server RUNNING) — reads the fixture, drives the real
 *                  HTTP login/session/logout cycle against the exempt
 *                  tenant, and the billing-gate 402 behavior against the
 *                  'incomplete' one.
 *   3. `--cleanup` (server STOPPED again) — deletes both test tenants.
 *
 * Skips the one step this sandbox can't reach live Pipedrive for
 * (signup's token-verification call — see verify-portal.ts's doc comment)
 * by seeding tenants directly via the DB layer instead of going through
 * POST /api/signup.
 */
import "dotenv/config";
import fs from "fs";
import fetch from "node-fetch";
import crypto from "crypto";
import { db } from "./db";
import { hashPassword } from "./lib/auth";

const BASE = process.env.VERIFY_BASE_URL || "http://localhost:8787";
const FIXTURE_PATH = "/tmp/verify-portal-http-fixture.json";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`✅ ${msg}`);
}

function extractCookie(res: any): string {
  const raw = res.headers.get("set-cookie");
  if (!raw) throw new Error("No Set-Cookie header in response");
  return raw.split(";")[0]; // "as_portal_session=<value>"
}

async function seed() {
  const email = `verify-http-${Date.now()}@example.com`;
  const password = "http-test-password-1";
  const tenant = await db.tenant.create({
    id: `verify-http-${Date.now()}`,
    name: "Verify HTTP Co",
    trackKey: crypto.randomBytes(8).toString("hex"),
    webhookSecret: crypto.randomBytes(8).toString("hex"),
    signupEmail: email,
    passwordHash: hashPassword(password),
    signupSource: "self_serve",
    // Explicitly exempt: this script tests auth/session HTTP mechanics
    // (login, cookie, logout), not billing enforcement — a plain
    // self_serve tenant would otherwise default to 'incomplete' and get
    // 402'd by requireActiveBilling before any of that gets exercised.
    // The billing-gate tenant below covers that behavior instead.
    subscriptionStatus: "exempt",
  });

  // A second tenant, deliberately left at the real self-serve default
  // (subscriptionStatus 'incomplete', since no subscriptionStatus is
  // passed) — used to check requireActiveBilling actually blocks a
  // logged-in-but-unpaid tenant over real HTTP, complementing
  // verify-billing.ts's in-process check of the same isBillingActive
  // logic (that one can't exercise the Express middleware chain itself).
  const billingEmail = `verify-http-billing-${Date.now()}@example.com`;
  const billingPassword = "http-test-password-2";
  const billingTenant = await db.tenant.create({
    id: `verify-http-billing-${Date.now()}`,
    name: "Verify HTTP Billing Co",
    trackKey: crypto.randomBytes(8).toString("hex"),
    webhookSecret: crypto.randomBytes(8).toString("hex"),
    signupEmail: billingEmail,
    passwordHash: hashPassword(billingPassword),
    signupSource: "self_serve",
  });

  fs.writeFileSync(
    FIXTURE_PATH,
    JSON.stringify({
      tenantId: tenant.id,
      email,
      password,
      billingTenantId: billingTenant.id,
      billingEmail,
      billingPassword,
    })
  );
  console.log(`Seeded tenants "${tenant.id}" and "${billingTenant.id}". Now start the server, then run --run.`);
}

async function run() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));

  const health = await fetch(`${BASE}/health`);
  assert(health.ok, `server is reachable at ${BASE} (run \`npm run dev\` first if this fails)`);

  const badLogin = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: fixture.email, password: "wrong-password" }),
  });
  assert(badLogin.status === 401, "login: wrong password is rejected with 401");

  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: fixture.email, password: fixture.password }),
  });
  if (!login.ok) console.error("login response body:", await login.text());
  assert(login.ok, "login: correct email/password succeeds");
  const cookie = extractCookie(login);

  const meNoAuth = await fetch(`${BASE}/api/me`);
  assert(meNoAuth.status === 401, "/me: rejected with no session cookie");

  const me = await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
  assert(me.ok, "/me: succeeds with a valid session cookie");
  const meBody: any = await me.json();
  assert(meBody.tenantId === fixture.tenantId, "/me: returns the correct tenant for this session");

  const summary = await fetch(`${BASE}/api/summary`, { headers: { Cookie: cookie } });
  assert(summary.ok, "/summary: succeeds with a valid session cookie");
  const summaryBody: any = await summary.json();
  assert(
    summaryBody.totalIdentities === 0 && Array.isArray(summaryBody.recent),
    "/summary: brand-new tenant with no touchpoints returns a well-formed, empty summary"
  );

  const logout = await fetch(`${BASE}/api/logout`, { method: "POST", headers: { Cookie: cookie } });
  assert(logout.ok, "logout: succeeds");

  const meAfterLogout = await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
  assert(
    meAfterLogout.status === 401,
    "/me: same cookie is rejected after logout — session actually invalidated, not just cleared client-side"
  );

  // --- billing gate, against the second (deliberately 'incomplete') tenant ---
  const billingLogin = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: fixture.billingEmail, password: fixture.billingPassword }),
  });
  assert(billingLogin.ok, "billing gate: login still succeeds for an unpaid ('incomplete') tenant");
  const billingCookie = extractCookie(billingLogin);

  const billingMe = await fetch(`${BASE}/api/me`, { headers: { Cookie: billingCookie } });
  assert(billingMe.ok, "billing gate: /me stays reachable while gated, so the dashboard can show why");
  const billingMeBody: any = await billingMe.json();
  assert(billingMeBody.billing?.status === "incomplete", "billing gate: /me reports subscriptionStatus 'incomplete' for a tenant that never finished Checkout");

  const billingSummary = await fetch(`${BASE}/api/summary`, { headers: { Cookie: billingCookie } });
  assert(billingSummary.status === 402, "billing gate: /summary is blocked with 402 for an 'incomplete' tenant");
  const billingSummaryBody: any = await billingSummary.json();
  assert(billingSummaryBody.error === "billing_required", "billing gate: 402 body identifies itself as billing_required, not a generic error");

  console.log("\n✅ All portal HTTP checks passed. Stop the server and run --cleanup next.");
}

async function cleanup() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
  await db.tenant.delete(fixture.tenantId);
  await db.tenant.delete(fixture.billingTenantId);
  fs.unlinkSync(FIXTURE_PATH);
  console.log(`Cleaned up tenants "${fixture.tenantId}" and "${fixture.billingTenantId}".`);
}

const mode = process.argv[2];
const fn = mode === "--seed" ? seed : mode === "--run" ? run : mode === "--cleanup" ? cleanup : null;
if (!fn) {
  console.error("Usage: ts-node src/verify-portal-http.ts --seed | --run | --cleanup");
  console.error("(server must be STOPPED for --seed and --cleanup, RUNNING for --run — see file header)");
  process.exit(1);
}

fn().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
