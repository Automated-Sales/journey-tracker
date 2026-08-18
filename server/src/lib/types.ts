export type Channel =
  | "ad_click"
  | "ad_impression"
  | "website_visit"
  | "social_organic"
  | "email_open"
  | "email_click"
  | "email_reply"
  | "pipedrive_activity"
  | "pipedrive_stage_change"
  | "pipedrive_note"
  // A per-tenant configured fallback (Tenant.leadSourceFieldKey) — used
  // only when a Lead arrives for an identity with zero other
  // touchpoints, i.e. someone our own tracking never saw at all. See
  // webhooks.ts's "lead" handler and db.ts's Tenant interface doc
  // comment for the fuller reasoning.
  | "lead_source_field";

export interface RawTouchpoint {
  channel: Channel;
  source: string;
  campaign?: string | null;
  medium?: string | null;
  content?: string | null;
  term?: string | null;
  clickId?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  msclkid?: string | null;
  liFatId?: string | null;
  referrer?: string | null;
  url?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string | Date;
  email?: string | null;
  anonymousId?: string | null;
  pipedrivePersonId?: number | null;
}
