export interface Touchpoint {
  id: string;
  channel: string;
  source: string;
  campaign?: string | null;
  medium?: string | null;
  content?: string | null;
  term?: string | null;
  clickId?: string | null;
  url?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
}

export interface JourneyResponse {
  identity: { id: string; email: string | null; firstSeenAt: string; lastSeenAt: string } | null;
  touchpoints: Touchpoint[];
}

// One panel deployment serves every client — the Pipedrive Developer Hub
// app extension is registered per-tenant with a ?tenant=<slug> query
// param on its iframe URL (see pipedrive-app/README.md), so the same
// static build knows which client's data to call the API for.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

function tenantFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("tenant");
}

function tenantApiUrl(path: string): string {
  const tenant = tenantFromUrl();
  if (!tenant) throw new Error("Missing ?tenant=<slug> on the panel iframe URL");
  return `${API_BASE_URL}/t/${encodeURIComponent(tenant)}/api${path}`;
}

export async function fetchJourneyByPerson(personId: number): Promise<JourneyResponse> {
  const res = await fetch(tenantApiUrl(`/journey/by-person/${personId}`));
  if (!res.ok) throw new Error(`Journey API returned ${res.status}`);
  return res.json();
}

export async function fetchJourneyByDeal(dealId: number): Promise<JourneyResponse> {
  const res = await fetch(tenantApiUrl(`/journey/by-deal/${dealId}`));
  if (!res.ok) throw new Error(`Journey API returned ${res.status}`);
  return res.json();
}
