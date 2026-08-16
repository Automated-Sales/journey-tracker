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
 *   1. `--seed`    (server STOPPED) — creates the test tenant, writes its
 *                  credentials to a fixture file.
 *      (start the server now, so it loads the tenant `--seed` just wrote)
 *   2. `--run`     (server RUNNING) — reads the fixture, drives the real
 *                  HTTP login/session/logout cycle against it.
 *   3. `--cleanup` (server STOPPED again) — deletes the test tenant.
 *
 * Skips the one step this sandbox can't reach live Pipedrive for
 * (signup's token-verification call — see verify-portal.ts's doc comment)
 * by seeding the tenant directly via the DB layer instead of going
 * through POST /api/signup.
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
  });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify({ tenantId: tenant.id, email, password }));
  console.log(`Seeded tenant "${tenant.id}". Now start the server, then run --run.`);
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

  console.log("\n✅ All portal HTTP checks passed. Stop the server and run --cleanup next.");
}

async function cleanup() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
  await db.tenant.delete(fixture.tenantId);
  fs.unlinkSync(FIXTURE_PATH);
  console.log(`Cleaned up tenant "${fixture.tenantId}".`);
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
