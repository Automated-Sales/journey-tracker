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
  | "pipedrive_note";

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
  referrer?: string | null;
  url?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string | Date;
  email?: string | null;
  anonymousId?: string | null;
  pipedrivePersonId?: number | null;
}
