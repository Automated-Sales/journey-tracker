import { Touchpoint } from "../db";

/**
 * Pure counting helpers behind the two deal-lifecycle milestones
 * (leadToDealTouchpoints, dealToWonTouchpoints — see db.ts's Identity
 * interface and routes/webhooks.ts's deal handler, which is the only
 * caller). Pulled out into their own testable functions rather than
 * inlined in the webhook handler, the same reasoning as
 * lib/attribution.ts's buildAttributionSummary: this is where a
 * boundary-condition bug (off-by-one at the exact cutoff moment) would
 * hide, so it needs to be unit-testable without spinning up the whole
 * webhook request/DB/Pipedrive round trip. See verify-attribution.ts.
 */

/**
 * "How many touchpoints happened before/at this contact became a Deal" —
 * inclusive of the cutoff itself, since the touchpoint that IS the
 * deal-creation moment (e.g. a form submit that triggers Pipedrive
 * Person/Deal creation in the same instant) should count as part of the
 * lead journey that led to the deal, not be excluded by a strict `<`.
 */
export function countTouchpointsUpTo(touchpoints: Touchpoint[], cutoff: Date): number {
  const cutoffMs = cutoff.getTime();
  return touchpoints.filter((t) => t.occurredAt.getTime() <= cutoffMs).length;
}

/**
 * "How many touchpoints happened between this contact's Deal being
 * created and it being marked Won" — strictly after `start` (so the
 * creation-moment touchpoint already counted in countTouchpointsUpTo
 * above isn't double-counted here too) and inclusive of `end`.
 */
export function countTouchpointsBetween(touchpoints: Touchpoint[], start: Date, end: Date): number {
  const startMs = start.getTime();
  const endMs = end.getTime();
  return touchpoints.filter((t) => t.occurredAt.getTime() > startMs && t.occurredAt.getTime() <= endMs).length;
}
