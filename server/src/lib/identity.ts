import { db, Tenant } from "../db";
import { RawTouchpoint } from "./types";
import { syncPersonAttribution } from "./pipedrive-sync";

/**
 * Identity resolution is the crux of this whole system: a prospect touches
 * five different channels under three different "handles" (an anonymous
 * cookie ID on the website, a click ID from an ad, an email address once
 * they convert, and a Pipedrive Person ID once a rep creates the record).
 * This module's job is to collapse all of those into one Identity row so
 * the journey timeline is complete instead of fragmented.
 *
 * Every function here is scoped to one `tenant` (one client business) —
 * identities and touchpoints never cross tenant boundaries; see db.ts,
 * where every query is filtered by tenantId.
 *
 * Resolution order, cheapest/most-certain first:
 *   1. pipedrivePersonId match (set once we know it — never changes)
 *   2. email match (case-insensitive)
 *   3. anonymousId match (website cookie, set before we know who they are)
 *   4. none of the above -> create a new, still-anonymous Identity
 */
export async function resolveIdentity(tenant: Tenant, tp: RawTouchpoint) {
  const tenantId = tenant.id;
  const email = tp.email?.trim().toLowerCase() || null;
  const anonymousId = tp.anonymousId || null;
  const pipedrivePersonId = tp.pipedrivePersonId ?? null;

  let identity = null as Awaited<ReturnType<typeof db.identity.findFirst>> | null;

  if (pipedrivePersonId) {
    identity = await db.identity.findUnique({ where: { tenantId, pipedrivePersonId } });
  }
  if (!identity && email) {
    identity = await db.identity.findUnique({ where: { tenantId, email } });
  }
  if (!identity && anonymousId) {
    identity = await db.identity.findFirst({
      where: { tenantId, anonymousIds: { contains: anonymousId } },
    });
  }

  if (!identity) {
    identity = await db.identity.create({
      data: {
        tenantId,
        email: email ?? undefined,
        pipedrivePersonId: pipedrivePersonId ?? undefined,
        anonymousIds: anonymousId ?? "",
      },
    });
    return identity;
  }

  // Merge in anything new we've just learned about this person.
  const mergedAnonymousIds = new Set(
    identity.anonymousIds ? identity.anonymousIds.split(",").filter(Boolean) : []
  );
  if (anonymousId) mergedAnonymousIds.add(anonymousId);

  const updateData: Record<string, unknown> = {
    lastSeenAt: new Date(),
    anonymousIds: Array.from(mergedAnonymousIds).join(","),
  };
  if (email && !identity.email) updateData.email = email;
  if (pipedrivePersonId && !identity.pipedrivePersonId) {
    updateData.pipedrivePersonId = pipedrivePersonId;
  }

  identity = await db.identity.update({
    where: { tenantId, id: identity.id },
    data: updateData,
  });

  return identity;
}

/**
 * Explicit merge: called when a form submit or Pipedrive sync tells us
 * "this anonymousId IS this email" or "this email IS this Pipedrive person".
 * If two separate Identity rows already exist for the two handles, they're
 * folded into one (the older row wins as the canonical record).
 */
export async function mergeIdentities(
  tenant: Tenant,
  params: {
    email?: string | null;
    anonymousId?: string | null;
    pipedrivePersonId?: number | null;
    pipedriveDealId?: number | null;
  }
) {
  const tenantId = tenant.id;
  const email = params.email?.trim().toLowerCase() || null;
  const candidates = [];

  if (email) {
    const byEmail = await db.identity.findUnique({ where: { tenantId, email } });
    if (byEmail) candidates.push(byEmail);
  }
  if (params.anonymousId) {
    const byAnon = await db.identity.findFirst({
      where: { tenantId, anonymousIds: { contains: params.anonymousId } },
    });
    if (byAnon) candidates.push(byAnon);
  }
  if (params.pipedrivePersonId) {
    const byPerson = await db.identity.findUnique({
      where: { tenantId, pipedrivePersonId: params.pipedrivePersonId },
    });
    if (byPerson) candidates.push(byPerson);
  }

  const unique = Array.from(new Map(candidates.map((c) => [c.id, c])).values());

  let primary = unique.sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime())[0];

  if (!primary) {
    primary = await db.identity.create({
      data: {
        tenantId,
        email: email ?? undefined,
        anonymousIds: params.anonymousId ?? "",
        pipedrivePersonId: params.pipedrivePersonId ?? undefined,
      },
    });
  }

  // Re-point touchpoints from any duplicate rows onto the primary, then
  // delete the duplicates.
  const duplicates = unique.filter((c) => c.id !== primary.id);
  for (const dup of duplicates) {
    await db.touchpoint.updateMany({
      where: { tenantId, identityId: dup.id },
      data: { identityId: primary.id },
    });
    await db.identity.delete({ where: { tenantId, id: dup.id } });
  }

  const mergedAnonymousIds = new Set(
    primary.anonymousIds ? primary.anonymousIds.split(",").filter(Boolean) : []
  );
  if (params.anonymousId) mergedAnonymousIds.add(params.anonymousId);
  for (const dup of duplicates) {
    dup.anonymousIds.split(",").filter(Boolean).forEach((id) => mergedAnonymousIds.add(id));
  }

  const mergedDealIds = new Set(
    primary.pipedriveDealIds ? primary.pipedriveDealIds.split(",").filter(Boolean) : []
  );
  if (params.pipedriveDealId) mergedDealIds.add(String(params.pipedriveDealId));

  primary = await db.identity.update({
    where: { tenantId, id: primary.id },
    data: {
      email: email ?? primary.email ?? undefined,
      pipedrivePersonId: params.pipedrivePersonId ?? primary.pipedrivePersonId ?? undefined,
      anonymousIds: Array.from(mergedAnonymousIds).join(","),
      pipedriveDealIds: Array.from(mergedDealIds).join(","),
      lastSeenAt: new Date(),
    },
  });

  return primary;
}

export async function recordTouchpoint(tenant: Tenant, tp: RawTouchpoint) {
  const tenantId = tenant.id;
  const identity = await resolveIdentity(tenant, tp);

  const touchpoint = await db.touchpoint.create({
    data: {
      tenantId,
      identityId: identity.id,
      anonymousId: tp.anonymousId ?? undefined,
      channel: tp.channel,
      source: tp.source,
      campaign: tp.campaign ?? undefined,
      medium: tp.medium ?? undefined,
      content: tp.content ?? undefined,
      term: tp.term ?? undefined,
      clickId: tp.clickId ?? undefined,
      gclid: tp.gclid ?? undefined,
      fbclid: tp.fbclid ?? undefined,
      msclkid: tp.msclkid ?? undefined,
      referrer: tp.referrer ?? undefined,
      url: tp.url ?? undefined,
      title: tp.title ?? undefined,
      metadata: tp.metadata ? JSON.stringify(tp.metadata) : undefined,
      occurredAt: tp.occurredAt ? new Date(tp.occurredAt) : new Date(),
    },
  });

  // Best-effort, not on the hot path: don't make every pageview or email
  // event wait on a round trip to Pipedrive. syncPersonAttribution never
  // throws (it catches and logs internally), this .catch is just a backstop.
  void syncPersonAttribution(tenant, identity).catch((err) => console.error("[recordTouchpoint] sync failed:", err));

  return { identity, touchpoint };
}
