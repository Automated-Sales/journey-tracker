import fs from "fs";
import path from "path";
import crypto from "crypto";
import initSqlJs, { Database as SqlJsDatabase } from "sql.js";

/**
 * Zero-dependency, multi-tenant data layer built on sql.js (SQLite
 * compiled to WASM — see the note in the original single-tenant version
 * of this file for why: Prisma and better-sqlite3 both depend on a
 * binary-hosting domain that isn't reachable from every network, sql.js
 * ships its WASM inside the npm package itself).
 *
 * Multi-tenant: one server instance serves many client businesses, each
 * with their own Pipedrive account. Every Identity and Touchpoint row is
 * scoped by tenantId; a Tenant row holds that client's Pipedrive
 * credentials, per-channel webhook secret, snippet track key, and their
 * synced custom-field key map. There is no "default tenant" — every
 * request must resolve to a real tenant (see routes/tenant-middleware.ts).
 */

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "dev.db");

let sqlite: SqlJsDatabase;
let ready: Promise<void>;

function persist() {
  const data = sqlite.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function init() {
  const SQL = await initSqlJs();
  sqlite = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,               -- URL-safe slug, e.g. "acme-co"
      name TEXT NOT NULL,
      pipedriveApiToken TEXT,
      pipedriveCompanyDomain TEXT,
      trackKey TEXT NOT NULL,            -- scopes the client-side tracking snippet
      webhookSecret TEXT NOT NULL,       -- shared across this tenant's Pipedrive/email/ads webhook URLs
      personFieldMap TEXT,               -- JSON: localKey -> Pipedrive field key, set by setup:pipedrive
      dealFieldMap TEXT,                 -- JSON: localKey -> Pipedrive field key
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,            -- random session id, stored in the portal's httpOnly cookie
      tenantId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenantId);

    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      tenantId TEXT NOT NULL,
      email TEXT,
      name TEXT,
      phone TEXT,
      anonymousIds TEXT NOT NULL DEFAULT '',
      pipedrivePersonId INTEGER,
      pipedriveDealIds TEXT NOT NULL DEFAULT '',
      pipedriveLeadIds TEXT NOT NULL DEFAULT '',
      firstSeenAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      UNIQUE(tenantId, email),
      UNIQUE(tenantId, pipedrivePersonId)
    );

    CREATE TABLE IF NOT EXISTS touchpoints (
      id TEXT PRIMARY KEY,
      tenantId TEXT NOT NULL,
      identityId TEXT,
      anonymousId TEXT,
      channel TEXT NOT NULL,
      source TEXT NOT NULL,
      campaign TEXT,
      medium TEXT,
      content TEXT,
      term TEXT,
      clickId TEXT,
      url TEXT,
      title TEXT,
      metadata TEXT,
      occurredAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_identities_tenant ON identities(tenantId);
    CREATE INDEX IF NOT EXISTS idx_touchpoints_tenant ON touchpoints(tenantId);
    CREATE INDEX IF NOT EXISTS idx_touchpoints_identityId ON touchpoints(identityId);
    CREATE INDEX IF NOT EXISTS idx_touchpoints_anonymousId ON touchpoints(tenantId, anonymousId);
    CREATE INDEX IF NOT EXISTS idx_touchpoints_clickId ON touchpoints(tenantId, clickId);
    CREATE INDEX IF NOT EXISTS idx_touchpoints_occurredAt ON touchpoints(occurredAt);
  `);

  // Self-serve portal login (added after tenants already existed in the
  // wild from the CLI-only onboarding flow) — ALTER TABLE ADD COLUMN
  // rather than baking these into the CREATE TABLE above, so an existing
  // deployed tenants.db upgrades in place instead of needing a fresh DB.
  ensureColumn("tenants", "signupEmail", "TEXT");
  ensureColumn("tenants", "passwordHash", "TEXT");
  // 'cli' (onboarded by npm run add-tenant) or 'self_serve' (signed up
  // through the portal) — cosmetic, for admin visibility only.
  ensureColumn("tenants", "signupSource", "TEXT");
  // How long a visitor stayed on this touchpoint's page, in milliseconds.
  // Null until the tracking snippet reports it (fires on page/tab hide,
  // or immediately before tracking the next page on an SPA route change)
  // — a touchpoint always exists before its duration is known, so this is
  // filled in by a follow-up update, not at insert time. See
  // routes/track.ts's /track/duration and public/automated-sales-tracker.js.
  ensureColumn("touchpoints", "durationMs", "INTEGER");
  // How a client wants website visits (page + time on page) written to
  // Pipedrive: 'off' (default — the custom fields / panel still show
  // this, just nothing gets added to the Person/Deal's own Notes or
  // Activities feed), 'notes', or 'activities'. See lib/pipedrive-sync.ts
  // logWebsiteVisit and routes/track.ts's /track/duration handler, which
  // is where a touchpoint's duration (and therefore this decision) is
  // finally known.
  ensureColumn("tenants", "pipedriveVisitLogging", "TEXT");
  // Ad-platform click IDs, captured separately (rather than folded into
  // the pre-existing generic `clickId` column, which only ever kept one
  // value at a time and silently dropped the others when more than one
  // param was present) plus the raw HTTP referrer — all known at
  // touchpoint-creation time, straight from the tracking snippet's
  // /api/track payload. See lib/attribution.ts for how these roll up
  // into first-touch/last-touch summary fields.
  ensureColumn("touchpoints", "gclid", "TEXT");
  ensureColumn("touchpoints", "fbclid", "TEXT");
  ensureColumn("touchpoints", "msclkid", "TEXT");
  ensureColumn("touchpoints", "referrer", "TEXT");
  // Deal-lifecycle milestones: how much engagement happened before a
  // contact became a Deal, and before that Deal was Won — frozen once
  // each (not living/recalculated), the same way freezeDealAttribution's
  // Pipedrive fields are, but mirrored into our own DB too so the
  // dashboard's Recently active prospects list can show them without an
  // extra Pipedrive round trip. See webhooks.ts's deal handler for where
  // these get set, and db.identity.setDealMilestone. The *DealId columns
  // exist purely to dedup a repeated webhook delivery of the same
  // creation/won event — this app assumes one deal-per-contact matters
  // for this feature (consistent with the visit-logging feature's same
  // "exactly one open deal" simplifying assumption elsewhere), so a
  // second deal later would simply overwrite these rather than track
  // multiple deals' milestones separately.
  ensureColumn("identities", "dealCreatedDealId", "INTEGER");
  ensureColumn("identities", "dealCreatedAt", "TEXT");
  ensureColumn("identities", "leadToDealTouchpoints", "INTEGER");
  ensureColumn("identities", "wonDealId", "INTEGER");
  ensureColumn("identities", "dealToWonTouchpoints", "INTEGER");
  // See the Identity interface's doc comment on dealWonAt — the moment
  // this was computed but never saved anywhere.
  ensureColumn("identities", "dealWonAt", "TEXT");
  ensureColumn("identities", "dealValue", "REAL");
  ensureColumn("identities", "dealCurrency", "TEXT");
  // Added when Lead-level (pre-Deal-conversion) attribution sync was
  // built — see pipedrive-sync.ts's syncLeadAttribution and
  // webhooks.ts's "lead" entity handler. Any tenant row created before
  // this needs the column added via ALTER TABLE, same as the milestone
  // columns above; ensureColumn handles that transparently.
  ensureColumn("identities", "pipedriveLeadIds", "TEXT NOT NULL DEFAULT ''");
  // The permanent freeze guard for Lead-source attribution — see
  // pipedrive-sync.ts's freezeLeadAttribution. Once set, it marks "this
  // identity's original enquiry source has already been captured
  // forever" and nothing is allowed to overwrite it again, even if more
  // Lead webhook events arrive later (e.g. the Lead being edited,
  // disregarded, or a second Lead opened for the same contact) — that's
  // the whole point: a "permanent source of the Lead," not a living
  // field. Mirrors dealCreatedDealId/dealCreatedAt's role as both the
  // milestone value and its own idempotency guard.
  ensureColumn("identities", "leadCreatedAt", "TEXT");
  ensureColumn("identities", "leadCreatedLeadId", "TEXT");
  // A fallback identifier for the dashboard's Contact column when email
  // is unknown — some clients (Johari included) receive real leads with
  // only a phone number, never an email, so "(anonymous)" was showing
  // for contacts that are actually fully identified in Pipedrive. Pulled
  // from Pipedrive's own Person record (name, phones[].value) the same
  // moment webhooks.ts's backfillContactFromPipedrive already fetches it
  // to backfill email — no extra API calls, just capturing more of a
  // response already being requested. Deliberately NOT used as a
  // matching/merge key the way email is (see mergeIdentities) — phone
  // numbers get reformatted inconsistently and can be shared (an office
  // landline logged against several contacts), so treating two different
  // touchpoints with "the same" phone as necessarily the same person
  // would risk silently merging unrelated prospects. This is display-only.
  ensureColumn("identities", "name", "TEXT");
  ensureColumn("identities", "phone", "TEXT");
  // Billing (self-serve tenants only — see lib/stripe.ts,
  // routes/portal.ts's requireActiveBilling, and the README's "Billing"
  // section). NULL in the DB is resolved to a real default at read time
  // (rowToTenant) rather than backfilled here, same pattern as
  // pipedriveVisitLogging above: every tenant that existed before this
  // column did was CLI-onboarded (self-serve signup didn't exist yet
  // either), so NULL safely means "exempt, not billing-gated" for all of
  // them without a migration pass.
  ensureColumn("tenants", "stripeCustomerId", "TEXT");
  ensureColumn("tenants", "stripeSubscriptionId", "TEXT");
  ensureColumn("tenants", "subscriptionStatus", "TEXT");
  ensureColumn("tenants", "trialEndsAt", "TEXT");
  ensureColumn("tenants", "currentPeriodEnd", "TEXT");
  // See the Tenant interface's doc comment above these two fields for
  // the fuller reasoning — a per-tenant fallback source for leads our
  // own tracking never saw.
  ensureColumn("tenants", "leadSourceFieldKey", "TEXT");
  ensureColumn("tenants", "leadSourceFieldLabel", "TEXT");

  persist();
}

function ensureColumn(table: string, column: string, type: string) {
  const cols = queryAll(`PRAGMA table_info(${table})`, []);
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    sqlite.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

ready = init();

async function withDb<T>(fn: () => T): Promise<T> {
  await ready;
  return fn();
}

export interface Tenant {
  id: string;
  name: string;
  pipedriveApiToken: string | null;
  pipedriveCompanyDomain: string | null;
  trackKey: string;
  webhookSecret: string;
  personFieldMap: Record<string, string> | null;
  dealFieldMap: Record<string, string> | null;
  // Portal login (self-serve tenants only — CLI-onboarded tenants have
  // both null and simply can't log into /dashboard).
  signupEmail: string | null;
  passwordHash: string | null;
  signupSource: "cli" | "self_serve" | null;
  // Defaults to "off" at read time (rowToTenant) rather than at insert
  // time, so existing tenants created before this column existed don't
  // need a migration/backfill — a NULL in the DB just means "off."
  pipedriveVisitLogging: "off" | "notes" | "activities";
  // Billing (see ensureColumn's comment above for the NULL-default
  // reasoning). 'exempt' = never billing-gated — every CLI-onboarded
  // tenant, by default (see add-tenant.ts), plus any self-serve tenant
  // Dan chooses to comp by hand-editing this column. 'incomplete' = a
  // self-serve signup that hasn't finished Stripe Checkout yet.
  // 'trialing'/'active'/'past_due'/'canceled' mirror Stripe's own
  // subscription.status values directly (see lib/stripe.ts), updated only
  // by the /webhooks/stripe handler — never written optimistically from
  // the checkout-session-creation code path, so this always reflects what
  // Stripe itself last reported, not what we hoped would happen.
  subscriptionStatus: "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "exempt";
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  createdAt: Date;
  // Optional per-tenant fallback attribution source — configured via
  // Stage 2's settings page (not yet built; for now, set via
  // set-tenant-lead-source-field.ts). When a Lead webhook arrives for an
  // identity with NO existing touchpoints at all (see webhooks.ts's
  // "lead" handler), the value of this Pipedrive Lead/Deal custom field
  // — read straight off the webhook payload, no extra API call needed —
  // becomes that identity's one and only first-touch source. This never
  // overrides real tracked data; it only fills the gap for a lead that
  // came in through a channel our own tracking snippet could never see
  // (e.g. a native Facebook Lead Form feeding Pipedrive through a
  // third-party tool like WhatConverts, with no website visit at all).
  // leadSourceFieldKey is the raw Pipedrive field key (the long hash);
  // leadSourceFieldLabel is the human-readable name, stored purely for
  // display (e.g. on a future settings page showing "currently mapped:
  // Social Form Source") — never used for matching/lookup.
  leadSourceFieldKey: string | null;
  leadSourceFieldLabel: string | null;
}

export interface Session {
  token: string;
  tenantId: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface Identity {
  id: string;
  tenantId: string;
  email: string | null;
  // Display-only fallback identifiers, captured from Pipedrive's Person
  // record — see db.ts's ensureColumn call for the fuller reasoning
  // (not a matching key, unlike email).
  name: string | null;
  phone: string | null;
  anonymousIds: string;
  pipedrivePersonId: number | null;
  pipedriveDealIds: string;
  // Comma-separated Lead IDs (Pipedrive Lead ids are UUID strings, not
  // integers — unlike pipedriveDealIds/pipedrivePersonId above) this
  // identity is linked to. A prospect can have more than one open Lead
  // in principle, same reasoning as pipedriveDealIds being a list rather
  // than a single value. See lib/pipedrive-sync.ts's syncLeadAttribution.
  pipedriveLeadIds: string;
  // Set exactly once, the first time we see any Lead webhook event for
  // this identity — see pipedrive-sync.ts's freezeLeadAttribution. Null
  // until then; never changes again afterward, by design.
  leadCreatedAt: Date | null;
  leadCreatedLeadId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  // Deal-lifecycle milestones — see ensureColumn's doc comment above and
  // webhooks.ts's deal handler. Null until (respectively) this identity's
  // deal has been created / won.
  dealCreatedDealId: number | null;
  dealCreatedAt: Date | null;
  leadToDealTouchpoints: number | null;
  wonDealId: number | null;
  dealToWonTouchpoints: number | null;
  // Was computed in-memory to derive dealToWonTouchpoints (see
  // webhooks.ts's deal "won" handler) but never actually saved until
  // now — needed by csv.ts's Google Ads conversion export, which
  // requires a real timestamp for the "Conversion Time" column.
  dealWonAt: Date | null;
  // The Deal's monetary value AT THE MOMENT IT WAS WON (not its
  // estimated value at creation, which can change during negotiation) —
  // captured alongside dealWonAt, same webhook handler. Powers revenue
  // reporting in portal-summary.ts (conversionBySource/
  // campaignPerformance's revenueByCurrency). Kept per-currency rather
  // than blended into one number — see revenueByCurrency's own doc
  // comment for why summing across different currencies would be wrong.
  dealValue: number | null;
  dealCurrency: string | null;
}

// The single, shared definition of "not anonymous" — used by the
// dashboard's Show/Hide anonymous toggle (both the on-screen table and
// the CSV export), and by pagination's filtering. An identity counts as
// identified once ANY of these is known, not just email — see
// ensureColumn's comment on identities.name/phone: a phone-only lead
// with a real name captured from Pipedrive isn't meaningfully
// "anonymous" anymore just because we never got their email. Accepts
// any object with these three fields (not strictly an Identity) so
// RecentProspect — the dashboard-facing shape derived from Identity,
// see lib/portal-summary.ts — can reuse the same check without a type
// dependency loop.
export function isIdentified(row: { email: string | null; name: string | null; phone: string | null }): boolean {
  return !!(row.email || row.name || row.phone);
}

export interface Touchpoint {
  id: string;
  tenantId: string;
  identityId: string | null;
  anonymousId: string | null;
  channel: string;
  source: string;
  campaign: string | null;
  medium: string | null;
  content: string | null;
  term: string | null;
  clickId: string | null;
  gclid: string | null;
  fbclid: string | null;
  msclkid: string | null;
  referrer: string | null;
  url: string | null;
  title: string | null;
  metadata: string | null;
  durationMs: number | null;
  occurredAt: Date;
  createdAt: Date;
}

function queryOne(sql: string, params: any[]): any | null {
  const stmt = sqlite.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function queryAll(sql: string, params: any[]): any[] {
  const stmt = sqlite.prepare(sql);
  stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function rowToTenant(row: any): Tenant | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    pipedriveApiToken: row.pipedriveApiToken ?? null,
    pipedriveCompanyDomain: row.pipedriveCompanyDomain ?? null,
    trackKey: row.trackKey,
    webhookSecret: row.webhookSecret,
    personFieldMap: row.personFieldMap ? JSON.parse(row.personFieldMap) : null,
    dealFieldMap: row.dealFieldMap ? JSON.parse(row.dealFieldMap) : null,
    signupEmail: row.signupEmail ?? null,
    passwordHash: row.passwordHash ?? null,
    signupSource: (row.signupSource as Tenant["signupSource"]) ?? null,
    pipedriveVisitLogging: (row.pipedriveVisitLogging as Tenant["pipedriveVisitLogging"]) || "off",
    // See the Tenant interface's doc comment: a NULL here means this
    // tenant predates billing entirely, so it defaults by signupSource —
    // 'cli' (or the historical null, from before signupSource itself
    // existed) is exempt; 'self_serve' without a status yet is
    // 'incomplete' (shouldn't actually happen post-launch, since
    // provisionSelfServeTenant always sets one explicitly, but this is
    // the safe fallback rather than silently granting access).
    subscriptionStatus:
      (row.subscriptionStatus as Tenant["subscriptionStatus"]) ||
      (row.signupSource === "self_serve" ? "incomplete" : "exempt"),
    stripeCustomerId: row.stripeCustomerId ?? null,
    stripeSubscriptionId: row.stripeSubscriptionId ?? null,
    trialEndsAt: row.trialEndsAt ? new Date(row.trialEndsAt) : null,
    currentPeriodEnd: row.currentPeriodEnd ? new Date(row.currentPeriodEnd) : null,
    createdAt: new Date(row.createdAt),
    leadSourceFieldKey: row.leadSourceFieldKey ?? null,
    leadSourceFieldLabel: row.leadSourceFieldLabel ?? null,
  };
}

function rowToIdentity(row: any): Identity | null {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email ?? null,
    name: row.name ?? null,
    phone: row.phone ?? null,
    anonymousIds: row.anonymousIds ?? "",
    pipedrivePersonId: row.pipedrivePersonId ?? null,
    pipedriveDealIds: row.pipedriveDealIds ?? "",
    pipedriveLeadIds: row.pipedriveLeadIds ?? "",
    leadCreatedAt: row.leadCreatedAt ? new Date(row.leadCreatedAt) : null,
    leadCreatedLeadId: row.leadCreatedLeadId ?? null,
    firstSeenAt: new Date(row.firstSeenAt),
    lastSeenAt: new Date(row.lastSeenAt),
    dealCreatedDealId: row.dealCreatedDealId ?? null,
    dealCreatedAt: row.dealCreatedAt ? new Date(row.dealCreatedAt) : null,
    leadToDealTouchpoints: row.leadToDealTouchpoints ?? null,
    wonDealId: row.wonDealId ?? null,
    dealToWonTouchpoints: row.dealToWonTouchpoints ?? null,
    dealWonAt: row.dealWonAt ? new Date(row.dealWonAt) : null,
    dealValue: typeof row.dealValue === "number" ? row.dealValue : row.dealValue ? Number(row.dealValue) : null,
    dealCurrency: row.dealCurrency ?? null,
  };
}

function rowToTouchpoint(row: any): Touchpoint | null {
  if (!row) return null;
  return { ...row, occurredAt: new Date(row.occurredAt), createdAt: new Date(row.createdAt) } as Touchpoint;
}

const newId = () => crypto.randomUUID();

export const db = {
  tenant: {
    findById(id: string) {
      return withDb(() => rowToTenant(queryOne("SELECT * FROM tenants WHERE id = ?", [id])));
    },

    list() {
      return withDb(() => queryAll("SELECT * FROM tenants ORDER BY createdAt ASC", []).map((r) => rowToTenant(r)!));
    },

    findBySignupEmail(email: string) {
      return withDb(() =>
        rowToTenant(queryOne("SELECT * FROM tenants WHERE signupEmail = ?", [email.toLowerCase().trim()]))
      );
    },

    create(data: {
      id: string;
      name: string;
      pipedriveApiToken?: string | null;
      pipedriveCompanyDomain?: string | null;
      trackKey: string;
      webhookSecret: string;
      signupEmail?: string | null;
      passwordHash?: string | null;
      signupSource?: "cli" | "self_serve" | null;
      // Almost always omitted — see the default below. Only add-tenant.ts's
      // (currently unused) escape hatch or a future admin tool would ever
      // pass this explicitly.
      subscriptionStatus?: Tenant["subscriptionStatus"];
    }) {
      return withDb(() => {
        const signupSource = data.signupSource ?? "cli";
        const row = {
          id: data.id,
          name: data.name,
          pipedriveApiToken: data.pipedriveApiToken ?? null,
          pipedriveCompanyDomain: data.pipedriveCompanyDomain ?? null,
          trackKey: data.trackKey,
          webhookSecret: data.webhookSecret,
          personFieldMap: null as string | null,
          dealFieldMap: null as string | null,
          signupEmail: data.signupEmail?.toLowerCase().trim() ?? null,
          passwordHash: data.passwordHash ?? null,
          signupSource,
          // CLI-onboarded tenants (Dan's own consulting clients, onboarded
          // by hand) are exempt from billing by default — the flat-fee
          // Stripe subscription is specifically the self-serve product's
          // billing model, not how every client relationship works. A
          // self-serve signup starts 'incomplete' until Stripe Checkout
          // completes (see routes/portal.ts's /api/billing/checkout-session
          // and the webhook handler in lib/stripe.ts).
          subscriptionStatus: data.subscriptionStatus ?? (signupSource === "self_serve" ? "incomplete" : "exempt"),
          stripeCustomerId: null as string | null,
          stripeSubscriptionId: null as string | null,
          trialEndsAt: null as string | null,
          currentPeriodEnd: null as string | null,
          createdAt: new Date().toISOString(),
        };
        sqlite.run(
          `INSERT INTO tenants (id, name, pipedriveApiToken, pipedriveCompanyDomain, trackKey, webhookSecret, personFieldMap, dealFieldMap, signupEmail, passwordHash, signupSource, subscriptionStatus, stripeCustomerId, stripeSubscriptionId, trialEndsAt, currentPeriodEnd, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.name,
            row.pipedriveApiToken,
            row.pipedriveCompanyDomain,
            row.trackKey,
            row.webhookSecret,
            row.personFieldMap,
            row.dealFieldMap,
            row.signupEmail,
            row.passwordHash,
            row.signupSource,
            row.subscriptionStatus,
            row.stripeCustomerId,
            row.stripeSubscriptionId,
            row.trialEndsAt,
            row.currentPeriodEnd,
            row.createdAt,
          ]
        );
        persist();
        return rowToTenant(row)!;
      });
    },

    updateFieldMaps(id: string, maps: { person: Record<string, string>; deal: Record<string, string> }) {
      return withDb(() => {
        sqlite.run("UPDATE tenants SET personFieldMap = ?, dealFieldMap = ? WHERE id = ?", [
          JSON.stringify(maps.person),
          JSON.stringify(maps.deal),
          id,
        ]);
        persist();
      });
    },

    updateVisitLogging(id: string, mode: "off" | "notes" | "activities") {
      return withDb(() => {
        sqlite.run("UPDATE tenants SET pipedriveVisitLogging = ? WHERE id = ?", [mode, id]);
        persist();
      });
    },

    findByStripeCustomerId(stripeCustomerId: string) {
      return withDb(() => rowToTenant(queryOne("SELECT * FROM tenants WHERE stripeCustomerId = ?", [stripeCustomerId])));
    },

    findByStripeSubscriptionId(stripeSubscriptionId: string) {
      return withDb(() =>
        rowToTenant(queryOne("SELECT * FROM tenants WHERE stripeSubscriptionId = ?", [stripeSubscriptionId]))
      );
    },

    // Partial update, Prisma-style (an omitted key leaves that column
    // untouched) — used exclusively by lib/stripe.ts's webhook handler, the
    // only code path allowed to move a tenant between billing states (see
    // the Tenant interface's doc comment on subscriptionStatus for why
    // nothing else writes these columns directly).
    updateBilling(
      id: string,
      data: Partial<
        Pick<Tenant, "stripeCustomerId" | "stripeSubscriptionId" | "subscriptionStatus" | "trialEndsAt" | "currentPeriodEnd">
      >
    ) {
      return withDb(() => {
        const existing = queryOne("SELECT * FROM tenants WHERE id = ?", [id]);
        if (!existing) throw new Error(`Tenant ${id} not found`);
        const definedData = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        const merged = { ...existing, ...definedData };
        const trialEndsAtIso = (merged.trialEndsAt as Date | string | null)
          ? new Date(merged.trialEndsAt as Date | string).toISOString()
          : null;
        const currentPeriodEndIso = (merged.currentPeriodEnd as Date | string | null)
          ? new Date(merged.currentPeriodEnd as Date | string).toISOString()
          : null;
        sqlite.run(
          `UPDATE tenants SET stripeCustomerId = ?, stripeSubscriptionId = ?, subscriptionStatus = ?, trialEndsAt = ?, currentPeriodEnd = ? WHERE id = ?`,
          [
            merged.stripeCustomerId ?? null,
            merged.stripeSubscriptionId ?? null,
            merged.subscriptionStatus ?? null,
            trialEndsAtIso,
            currentPeriodEndIso,
            id,
          ]
        );
        persist();
        return rowToTenant({ ...merged, trialEndsAt: trialEndsAtIso, currentPeriodEnd: currentPeriodEndIso })!;
      });
    },

    // Sets/changes the dashboard login for a tenant — the CLI-onboarding
    // equivalent of what provisionSelfServeTenant (lib/portal-signup.ts)
    // does automatically for self-serve signups. add-tenant.ts never sets
    // signupEmail/passwordHash itself, so any tenant created that way has
    // no way to log into /dashboard until this is run once — see
    // set-tenant-login.ts, the only caller.
    updateLogin(id: string, data: { signupEmail: string; passwordHash: string }) {
      return withDb(() => {
        const existing = queryOne("SELECT * FROM tenants WHERE id = ?", [id]);
        if (!existing) throw new Error(`Tenant ${id} not found`);
        sqlite.run("UPDATE tenants SET signupEmail = ?, passwordHash = ? WHERE id = ?", [
          data.signupEmail.toLowerCase().trim(),
          data.passwordHash,
          id,
        ]);
        persist();
      });
    },

    // Sets or clears (pass both fields null) the per-tenant fallback
    // lead-source field mapping — see the Tenant interface's doc comment
    // on leadSourceFieldKey. Currently only reachable via
    // set-tenant-lead-source-field.ts (Stage 1); a future settings page
    // (Stage 2) will call this same method from an authenticated route
    // instead of a CLI script.
    updateLeadSourceField(id: string, data: { leadSourceFieldKey: string | null; leadSourceFieldLabel: string | null }) {
      return withDb(() => {
        const existing = queryOne("SELECT * FROM tenants WHERE id = ?", [id]);
        if (!existing) throw new Error(`Tenant ${id} not found`);
        sqlite.run("UPDATE tenants SET leadSourceFieldKey = ?, leadSourceFieldLabel = ? WHERE id = ?", [
          data.leadSourceFieldKey,
          data.leadSourceFieldLabel,
          id,
        ]);
        persist();
      });
    },

    delete(id: string) {
      return withDb(() => {
        sqlite.run("DELETE FROM sessions WHERE tenantId = ?", [id]);
        sqlite.run("DELETE FROM touchpoints WHERE tenantId = ?", [id]);
        sqlite.run("DELETE FROM identities WHERE tenantId = ?", [id]);
        sqlite.run("DELETE FROM tenants WHERE id = ?", [id]);
        persist();
      });
    },
  },

  session: {
    create(data: { tenantId: string; ttlMs: number }) {
      return withDb(() => {
        const now = new Date();
        const row = {
          token: crypto.randomBytes(32).toString("hex"),
          tenantId: data.tenantId,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + data.ttlMs).toISOString(),
        };
        sqlite.run(`INSERT INTO sessions (token, tenantId, createdAt, expiresAt) VALUES (?, ?, ?, ?)`, [
          row.token,
          row.tenantId,
          row.createdAt,
          row.expiresAt,
        ]);
        persist();
        return { ...row, createdAt: now, expiresAt: new Date(row.expiresAt) } as Session;
      });
    },

    // Returns the session only if it exists AND hasn't expired — an
    // expired-but-still-present row is treated the same as no session by
    // every caller, so there's no separate "expired" branch to forget to
    // handle at the call site.
    findValid(token: string) {
      return withDb(() => {
        const row = queryOne("SELECT * FROM sessions WHERE token = ?", [token]);
        if (!row) return null;
        const session: Session = {
          token: row.token,
          tenantId: row.tenantId,
          createdAt: new Date(row.createdAt),
          expiresAt: new Date(row.expiresAt),
        };
        if (session.expiresAt.getTime() < Date.now()) return null;
        return session;
      });
    },

    delete(token: string) {
      return withDb(() => {
        sqlite.run("DELETE FROM sessions WHERE token = ?", [token]);
        persist();
      });
    },
  },

  identity: {
    findMany({ where }: { where: { tenantId: string } }) {
      return withDb(() =>
        queryAll("SELECT * FROM identities WHERE tenantId = ?", [where.tenantId]).map((r) => rowToIdentity(r)!)
      );
    },

    findUnique({
      where,
    }: {
      where: { tenantId: string; id?: string; email?: string | null; pipedrivePersonId?: number | null };
    }) {
      return withDb(() => {
        if (where.id) {
          return rowToIdentity(
            queryOne("SELECT * FROM identities WHERE tenantId = ? AND id = ?", [where.tenantId, where.id])
          );
        }
        if (where.email !== undefined && where.email !== null) {
          return rowToIdentity(
            queryOne("SELECT * FROM identities WHERE tenantId = ? AND email = ?", [where.tenantId, where.email])
          );
        }
        if (where.pipedrivePersonId !== undefined && where.pipedrivePersonId !== null) {
          return rowToIdentity(
            queryOne("SELECT * FROM identities WHERE tenantId = ? AND pipedrivePersonId = ?", [
              where.tenantId,
              where.pipedrivePersonId,
            ])
          );
        }
        return null;
      });
    },

    findFirst({ where }: { where: { tenantId: string; anonymousIds: { contains: string } } }) {
      return withDb(() => {
        const rows = queryAll("SELECT * FROM identities WHERE tenantId = ?", [where.tenantId]);
        const match = rows.find((r) =>
          (r.anonymousIds as string).split(",").filter(Boolean).includes(where.anonymousIds.contains)
        );
        return rowToIdentity(match);
      });
    },

    create({ data }: { data: Partial<Identity> & { tenantId: string } }) {
      return withDb(() => {
        const now = new Date().toISOString();
        const row = {
          id: newId(),
          tenantId: data.tenantId,
          email: data.email ?? null,
          name: data.name ?? null,
          phone: data.phone ?? null,
          anonymousIds: data.anonymousIds ?? "",
          pipedrivePersonId: data.pipedrivePersonId ?? null,
          pipedriveDealIds: data.pipedriveDealIds ?? "",
          pipedriveLeadIds: data.pipedriveLeadIds ?? "",
          firstSeenAt: now,
          lastSeenAt: now,
        };
        sqlite.run(
          `INSERT INTO identities (id, tenantId, email, name, phone, anonymousIds, pipedrivePersonId, pipedriveDealIds, pipedriveLeadIds, firstSeenAt, lastSeenAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.tenantId,
            row.email,
            row.name,
            row.phone,
            row.anonymousIds,
            row.pipedrivePersonId,
            row.pipedriveDealIds,
            row.pipedriveLeadIds,
            row.firstSeenAt,
            row.lastSeenAt,
          ]
        );
        persist();
        return rowToIdentity(row)!;
      });
    },

    update({ where, data }: { where: { tenantId: string; id: string }; data: Partial<Identity> }) {
      return withDb(() => {
        const existing = queryOne("SELECT * FROM identities WHERE tenantId = ? AND id = ?", [
          where.tenantId,
          where.id,
        ]);
        if (!existing) throw new Error(`Identity ${where.id} not found for tenant ${where.tenantId}`);
        // Prisma-like semantics: an explicitly `undefined` key in `data`
        // means "don't touch this field" — see lib/identity.ts merge chains.
        const definedData = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        const merged = {
          ...existing,
          ...definedData,
          lastSeenAt: (data.lastSeenAt as Date | undefined)?.toISOString?.() ?? new Date().toISOString(),
        };
        sqlite.run(
          `UPDATE identities SET email = ?, name = ?, phone = ?, anonymousIds = ?, pipedrivePersonId = ?, pipedriveDealIds = ?, pipedriveLeadIds = ?, lastSeenAt = ? WHERE tenantId = ? AND id = ?`,
          [
            merged.email,
            merged.name,
            merged.phone,
            merged.anonymousIds,
            merged.pipedrivePersonId,
            merged.pipedriveDealIds,
            merged.pipedriveLeadIds,
            merged.lastSeenAt,
            where.tenantId,
            where.id,
          ]
        );
        persist();
        return rowToIdentity(merged)!;
      });
    },

    // Separate from the general update() above deliberately — this
    // writes a distinct set of columns (the deal-lifecycle milestones)
    // Same idempotency/no-lastSeenAt-bump reasoning as setDealMilestone
    // below — this is a one-time freeze triggered by a Pipedrive webhook,
    // not a genuine new visitor touch. See webhooks.ts's "lead" handler,
    // the only call site.
    setLeadMilestone({
      where,
      data,
    }: {
      where: { tenantId: string; id: string };
      data: Partial<Pick<Identity, "leadCreatedAt" | "leadCreatedLeadId">>;
    }) {
      return withDb(() => {
        const existing = queryOne("SELECT * FROM identities WHERE tenantId = ? AND id = ?", [where.tenantId, where.id]);
        if (!existing) throw new Error(`Identity ${where.id} not found for tenant ${where.tenantId}`);
        const definedData = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        const merged = { ...existing, ...definedData };
        const leadCreatedAtIso = (merged.leadCreatedAt as Date | string | null)
          ? new Date(merged.leadCreatedAt as Date | string).toISOString()
          : null;
        sqlite.run(`UPDATE identities SET leadCreatedAt = ?, leadCreatedLeadId = ? WHERE tenantId = ? AND id = ?`, [
          leadCreatedAtIso,
          merged.leadCreatedLeadId ?? null,
          where.tenantId,
          where.id,
        ]);
        persist();
        return rowToIdentity({ ...merged, leadCreatedAt: leadCreatedAtIso })!;
      });
    },

    // and, unlike update(), does NOT bump lastSeenAt: a milestone write
    // happens on a Pipedrive webhook, not a genuine new visitor touch, so
    // stamping "last seen" here would be misleading. See webhooks.ts's
    // deal handler for the two call sites (deal created, deal won).
    setDealMilestone({
      where,
      data,
    }: {
      where: { tenantId: string; id: string };
      data: Partial<
        Pick<
          Identity,
          | "dealCreatedDealId"
          | "dealCreatedAt"
          | "leadToDealTouchpoints"
          | "wonDealId"
          | "dealToWonTouchpoints"
          | "dealWonAt"
          | "dealValue"
          | "dealCurrency"
        >
      >;
    }) {
      return withDb(() => {
        const existing = queryOne("SELECT * FROM identities WHERE tenantId = ? AND id = ?", [where.tenantId, where.id]);
        if (!existing) throw new Error(`Identity ${where.id} not found for tenant ${where.tenantId}`);
        // Prisma-like semantics, same as update() above: an explicitly
        // `undefined` key in `data` means "don't touch this column."
        const definedData = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        const merged = { ...existing, ...definedData };
        const dealCreatedAtIso = (merged.dealCreatedAt as Date | string | null)
          ? new Date(merged.dealCreatedAt as Date | string).toISOString()
          : null;
        const dealWonAtIso = (merged.dealWonAt as Date | string | null)
          ? new Date(merged.dealWonAt as Date | string).toISOString()
          : null;
        sqlite.run(
          `UPDATE identities SET dealCreatedDealId = ?, dealCreatedAt = ?, leadToDealTouchpoints = ?, wonDealId = ?, dealToWonTouchpoints = ?, dealWonAt = ?, dealValue = ?, dealCurrency = ? WHERE tenantId = ? AND id = ?`,
          [
            merged.dealCreatedDealId ?? null,
            dealCreatedAtIso,
            merged.leadToDealTouchpoints ?? null,
            merged.wonDealId ?? null,
            merged.dealToWonTouchpoints ?? null,
            dealWonAtIso,
            merged.dealValue ?? null,
            merged.dealCurrency ?? null,
            where.tenantId,
            where.id,
          ]
        );
        persist();
        return rowToIdentity({ ...merged, dealCreatedAt: dealCreatedAtIso, dealWonAt: dealWonAtIso })!;
      });
    },

    delete({ where }: { where: { tenantId: string; id: string } }) {
      return withDb(() => {
        sqlite.run("DELETE FROM identities WHERE tenantId = ? AND id = ?", [where.tenantId, where.id]);
        persist();
      });
    },
  },

  touchpoint: {
    create({
      data,
    }: {
      data: Partial<Touchpoint> & { tenantId: string; channel: string; source: string; occurredAt: Date };
    }) {
      return withDb(() => {
        const row = {
          id: newId(),
          tenantId: data.tenantId,
          identityId: data.identityId ?? null,
          anonymousId: data.anonymousId ?? null,
          channel: data.channel,
          source: data.source,
          campaign: data.campaign ?? null,
          medium: data.medium ?? null,
          content: data.content ?? null,
          term: data.term ?? null,
          clickId: data.clickId ?? null,
          gclid: data.gclid ?? null,
          fbclid: data.fbclid ?? null,
          msclkid: data.msclkid ?? null,
          referrer: data.referrer ?? null,
          url: data.url ?? null,
          title: data.title ?? null,
          metadata: data.metadata ?? null,
          occurredAt: (data.occurredAt as Date).toISOString(),
          createdAt: new Date().toISOString(),
        };
        sqlite.run(
          `INSERT INTO touchpoints (id, tenantId, identityId, anonymousId, channel, source, campaign, medium, content, term, clickId, gclid, fbclid, msclkid, referrer, url, title, metadata, occurredAt, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.tenantId,
            row.identityId,
            row.anonymousId,
            row.channel,
            row.source,
            row.campaign,
            row.medium,
            row.content,
            row.term,
            row.clickId,
            row.gclid,
            row.fbclid,
            row.msclkid,
            row.referrer,
            row.url,
            row.title,
            row.metadata,
            row.occurredAt,
            row.createdAt,
          ]
        );
        persist();
        return rowToTouchpoint(row)!;
      });
    },

    findMany({
      where,
      orderBy,
    }: {
      where: { tenantId: string; identityId: string };
      orderBy?: { occurredAt: "asc" | "desc" };
    }) {
      return withDb(() => {
        const dir = orderBy?.occurredAt === "desc" ? "DESC" : "ASC";
        const rows = queryAll(
          `SELECT * FROM touchpoints WHERE tenantId = ? AND identityId = ? ORDER BY occurredAt ${dir}`,
          [where.tenantId, where.identityId]
        );
        return rows.map((r) => rowToTouchpoint(r)!);
      });
    },

    // Every touchpoint across every identity for a tenant, oldest first —
    // used by the portal dashboard's aggregate summary (grouped by
    // identityId in lib/portal-summary.ts), not by the per-contact panel.
    findManyByTenant({ where }: { where: { tenantId: string } }) {
      return withDb(() => {
        const rows = queryAll(`SELECT * FROM touchpoints WHERE tenantId = ? ORDER BY occurredAt ASC`, [
          where.tenantId,
        ]);
        return rows.map((r) => rowToTouchpoint(r)!);
      });
    },

    // Fills in the one field a touchpoint can't know at creation time —
    // how long the visitor actually stayed. Scoped by tenantId even
    // though the route calling this already validated the trackKey,
    // as defense-in-depth against a touchpointId from another tenant.
    // Returns the updated row (or null if no touchpoint matched) so the
    // caller can act on the now-complete touchpoint — see
    // routes/track.ts, which uses this to decide whether to log the
    // visit to Pipedrive.
    updateDuration({ id, tenantId, durationMs }: { id: string; tenantId: string; durationMs: number }) {
      return withDb(() => {
        sqlite.run("UPDATE touchpoints SET durationMs = ? WHERE id = ? AND tenantId = ?", [
          durationMs,
          id,
          tenantId,
        ]);
        persist();
        return rowToTouchpoint(queryOne("SELECT * FROM touchpoints WHERE id = ? AND tenantId = ?", [id, tenantId]));
      });
    },

    // For backfill-activity-source.ts's one-off repair only — every
    // normal write path sets `source` once at creation (see create()
    // above) and never revisits it afterward.
    updateSource({ id, tenantId, source }: { id: string; tenantId: string; source: string }) {
      return withDb(() => {
        sqlite.run("UPDATE touchpoints SET source = ? WHERE id = ? AND tenantId = ?", [source, id, tenantId]);
        persist();
      });
    },

    updateMany({
      where,
      data,
    }: {
      where: { tenantId: string; identityId: string };
      data: { identityId: string };
    }) {
      return withDb(() => {
        sqlite.run("UPDATE touchpoints SET identityId = ? WHERE tenantId = ? AND identityId = ?", [
          data.identityId,
          where.tenantId,
          where.identityId,
        ]);
        persist();
      });
    },

    deleteMany({ where }: { where: { tenantId: string; identityId: string } }) {
      return withDb(() => {
        sqlite.run("DELETE FROM touchpoints WHERE tenantId = ? AND identityId = ?", [
          where.tenantId,
          where.identityId,
        ]);
        persist();
      });
    },
  },

  async $disconnect() {
    await ready;
  },
};
