import fetch from "node-fetch";

// Every function here takes the calling tenant's API token explicitly —
// this file has no notion of "the" Pipedrive account, because there are
// many (one per client business). See db.ts Tenant.pipedriveApiToken.

// Record CRUD (get/update Person, Deal) uses API v2 — Pipedrive's current
// generation, where custom field values live in a nested `custom_fields`
// object. Field *definition* management (creating/listing the custom
// fields themselves) uses the older, extremely stable v1 endpoints
// (`/personFields`, `/dealFields`) — well-documented for years, versus
// the newer v2 Fields API whose exact request shape wasn't something we
// could fully confirm from docs alone in this session. Mixing v1 and v2
// like this is explicitly supported by Pipedrive; verify against a real
// account the first time you run the setup script for a new tenant,
// since this is the one part of the integration we couldn't test against
// a live account.
function v2BaseUrl() {
  return "https://api.pipedrive.com/api/v2";
}
function v1BaseUrl() {
  return "https://api.pipedrive.com/v1";
}

async function pdFetch(token: string, base: string, path: string, init?: Record<string, unknown>) {
  if (!token) throw new Error("No Pipedrive API token provided for this tenant");
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${base}${path}${sep}api_token=${token}`, init as any);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pipedrive API ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

const pdFetchV2 = (token: string, path: string, init?: Record<string, unknown>) =>
  pdFetch(token, v2BaseUrl(), path, init);
const pdFetchV1 = (token: string, path: string, init?: Record<string, unknown>) =>
  pdFetch(token, v1BaseUrl(), path, init);

export async function getPerson(token: string, personId: number) {
  const json: any = await pdFetchV2(token, `/persons/${personId}`);
  return json.data;
}

export async function getDeal(token: string, dealId: number) {
  const json: any = await pdFetchV2(token, `/deals/${dealId}`);
  return json.data;
}

export async function findPersonByEmail(token: string, email: string) {
  const json: any = await pdFetchV2(
    token,
    `/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true`
  );
  return json.data?.items?.[0]?.item ?? null;
}

/**
 * Writes a short, human-readable note onto a Person (and optionally its
 * associated Deal, so reps see it whichever record they're looking at) —
 * so it shows up in Pipedrive's own Notes feed without opening a custom
 * panel. Used both for a one-off journey summary and, per-tenant setting,
 * for individual website-visit logging (see lib/pipedrive-sync.ts).
 * Pipedrive supports content as basic HTML (<b>, <br>, etc.).
 *
 * Deliberately v1, not v2: confirmed live against a real account that
 * POST /api/v2/notes isn't a real API v2 route — Notes never got migrated
 * the way Persons/Deals did, so it falls through to Pipedrive's web-app
 * router and comes back as a confusing HTML "405 Method Not Allowed"
 * instead of a clean JSON error. /v1/notes is the correct, stable
 * endpoint for this.
 */
export async function createNote(
  token: string,
  { content, personId, dealId }: { content: string; personId: number; dealId?: number }
) {
  return pdFetchV1(token, `/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, person_id: personId, ...(dealId ? { deal_id: dealId } : {}) }),
  });
}

/**
 * Logs a completed Activity against a Person (and optionally its Deal) —
 * the alternative to createNote for a tenant who'd rather see website
 * visits in their Activities feed than their Notes feed (see the
 * per-tenant `pipedriveVisitLogging` setting).
 *
 * `type` defaults to Pipedrive's built-in "task" key, which exists on
 * every account with no setup required — a tenant with a custom activity
 * type (e.g. one literally called "Website Visit") can pass its key here
 * instead once they've created it in their own account.
 *
 * Deliberately v1, not v2 — see createNote's comment above. Same failure
 * mode is plausible here (Activities has historically lagged the v2
 * migration too), so this uses the same known-stable v1 endpoint rather
 * than risk the same HTML-405 failure.
 */
export async function createActivity(
  token: string,
  {
    subject,
    note,
    personId,
    dealId,
    type = "task",
    done = true,
  }: { subject: string; note?: string; personId: number; dealId?: number; type?: string; done?: boolean }
) {
  return pdFetchV1(token, `/activities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject,
      type,
      done,
      person_id: personId,
      ...(dealId ? { deal_id: dealId } : {}),
      ...(note ? { note } : {}),
    }),
  });
}

export function deepLinkForPerson(companyDomain: string | null, personId: number) {
  if (!companyDomain) return null;
  return `https://${companyDomain}.pipedrive.com/person/${personId}`;
}

/**
 * GET /users/me — the standard way to both validate a token and learn
 * which company it belongs to in one call. Used by the self-serve portal
 * signup form so we can tell a client immediately if they pasted the
 * wrong token, and so we can prefill their Pipedrive company domain
 * instead of asking them to type it in. Confirmed against Pipedrive's
 * docs (endpoint + field names), not yet exercised against a live account
 * — this sandbox has no outbound network path to api.pipedrive.com to
 * test with (see README verification notes).
 */
export interface PipedriveMe {
  id: number;
  email: string;
  name: string;
  companyId: number;
  companyName: string;
  companyDomain: string;
}

export async function getMe(token: string): Promise<PipedriveMe> {
  const json: any = await pdFetchV1(token, `/users/me`);
  const d = json?.data;
  if (!d || !d.company_domain) {
    throw new Error(`Unexpected response from /users/me: ${JSON.stringify(json)}`);
  }
  return {
    id: d.id,
    email: d.email,
    name: d.name,
    companyId: d.company_id,
    companyName: d.company_name,
    companyDomain: d.company_domain,
  };
}

// ---------------------------------------------------------------------
// Custom field management (v1) — used only by the one-time setup script.
// ---------------------------------------------------------------------

export type PipedriveFieldType = "varchar" | "text" | "double" | "date";

export async function listPersonFields(token: string): Promise<any[]> {
  const json: any = await pdFetchV1(token, `/personFields`);
  return json.data ?? [];
}

export async function listDealFields(token: string): Promise<any[]> {
  const json: any = await pdFetchV1(token, `/dealFields`);
  return json.data ?? [];
}

// Leads have their OWN, completely separate Label system from Deals —
// confirmed via GET /v1/leadLabels returning {id (a UUID, not a small
// integer like Deal's), name, color} objects, distinct from Deal's
// built-in "label" field (in /dealFields, with small-integer option
// IDs). A Lead's own `label_ids` array (present directly on Lead
// webhook payloads and live records) references THIS set, not Deal's —
// see routes/portal.ts's listSegmentableFields for where these two
// sources get merged into one resolvable options list.
export async function listLeadLabels(token: string): Promise<Array<{ id: string; name: string }>> {
  const json: any = await pdFetchV1(token, `/leadLabels`);
  const data = json.data ?? [];
  return data
    .filter((l: any) => typeof l.id === "string" && typeof l.name === "string")
    .map((l: any) => ({ id: l.id, name: l.name }));
}

export async function createPersonField(
  token: string,
  name: string,
  field_type: PipedriveFieldType
): Promise<{ key: string }> {
  const json: any = await pdFetchV1(token, `/personFields`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, field_type }),
  });
  if (!json?.data?.key) {
    throw new Error(`Unexpected response creating person field "${name}": ${JSON.stringify(json)}`);
  }
  return json.data;
}

export async function createDealField(
  token: string,
  name: string,
  field_type: PipedriveFieldType
): Promise<{ key: string }> {
  const json: any = await pdFetchV1(token, `/dealFields`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, field_type }),
  });
  if (!json?.data?.key) {
    throw new Error(`Unexpected response creating deal field "${name}": ${JSON.stringify(json)}`);
  }
  return json.data;
}

// ---------------------------------------------------------------------
// Custom field value writes (v2) — used on every touchpoint/deal sync.
// ---------------------------------------------------------------------

/**
 * Pure, independently-testable: drops anything empty from our flat
 * { fieldKey: value } map so we never overwrite a field with a blank on a
 * partial sync.
 *
 * NOTE: for v2's simple custom field types (varchar/short text, text/long
 * text, double/number, date), the value goes directly on custom_fields —
 * i.e. { fieldKey: "Ad click" }, NOT { fieldKey: { value: "Ad click" } }.
 * The { value, ... } wrapper shape only applies to compound field types
 * (currency needs { value, currency }, single/multiple option needs an
 * id, etc) — none of which this integration uses. This was the one part
 * of the integration flagged as unverified against a live account (see
 * lib/pipedrive.ts's top comment); confirmed broken against a real
 * account via a 400 ERR_SCHEMA_VALIDATION_FAILED ("Expected 'string' as
 * short text custom field value") and fixed here.
 */
export function toCustomFieldsPayload(
  values: Record<string, string | number>
): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== null && v !== undefined && v !== "")
  );
}

export async function updatePersonCustomFields(
  token: string,
  personId: number,
  values: Record<string, string | number>
) {
  const custom_fields = toCustomFieldsPayload(values);
  if (Object.keys(custom_fields).length === 0) return null;
  return pdFetchV2(token, `/persons/${personId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ custom_fields }),
  });
}

export async function updateDealCustomFields(
  token: string,
  dealId: number,
  values: Record<string, string | number>
) {
  const custom_fields = toCustomFieldsPayload(values);
  if (Object.keys(custom_fields).length === 0) return null;
  return pdFetchV2(token, `/deals/${dealId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ custom_fields }),
  });
}

// Leads are a genuinely separate Pipedrive object from Deals — their own
// endpoint, their own id format (a UUID string, not an integer like
// Person/Deal ids) — even though the Deal custom fields we create also
// show up on a Lead's detail panel in Pipedrive's UI, because Leads and
// Deals share the same underlying custom-field *definitions*. That
// shared-definition behavior is what lets syncLeadAttribution reuse
// tenant.dealFieldMap rather than needing a separate field-creation step
// for Leads. As of this writing, Leads haven't been migrated to
// Pipedrive's v2 API the way Person/Deal have, so this uses v1 — and
// unlike Person/Deal's v2 endpoints (which wrap custom field values in a
// nested `custom_fields` object), a live test against Johari's account
// confirmed Leads reject that wrapper outright ("custom_fields" is not
// allowed) and expect each custom field key as a flat top-level property
// instead — the older v1-style convention that Person/Deal used before
// v2 existed.
export async function updateLeadCustomFields(
  token: string,
  leadId: string,
  values: Record<string, string | number>
) {
  const body = toCustomFieldsPayload(values);
  if (Object.keys(body).length === 0) return null;
  return pdFetchV1(token, `/leads/${leadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
