import Stripe from "stripe";
import { db, Tenant } from "../db";

/**
 * Stripe billing for self-serve tenants — the flat-monthly-fee, 14-day-
 * free-trial subscription described in the README's "Billing" section.
 * Deliberately the ONLY place in this codebase that talks to the Stripe
 * API or writes a tenant's subscriptionStatus; routes/portal.ts's billing
 * endpoints and index.ts's webhook route both call into this module
 * rather than touching Stripe or db.tenant.updateBilling directly, so
 * there's one place to reason about billing state transitions.
 *
 * Every export here throws if STRIPE_SECRET_KEY isn't configured, rather
 * than silently no-opping the way lib/pipedrive-sync.ts's best-effort
 * pushes do — a missing Pipedrive field sync is a shrug; a billing call
 * silently doing nothing would mean either charging nobody or (worse)
 * nobody ever getting billing-gated. Callers (routes/portal.ts) catch and
 * turn this into a clear 500 rather than letting checkout/portal buttons
 * fail silently.
 */

const TRIAL_DAYS = 14;

let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not configured — billing is unavailable until it's set in server/.env. See .env.example."
    );
  }
  if (!stripeClient) {
    stripeClient = new Stripe(key, { apiVersion: "2026-07-29.dahlia" });
  }
  return stripeClient;
}

/** Whether enough env vars are set for billing to function at all — used by add-tenant.ts/portal.ts to give a clear error instead of a Stripe SDK stack trace when it isn't. */
export function stripeConfigured(): boolean {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID && process.env.STRIPE_WEBHOOK_SECRET);
}

/**
 * Starts (or resumes, if this tenant already has a Stripe customer from an
 * abandoned attempt) a Checkout session for the one flat-fee subscription
 * plan, with the 14-day trial applied. Returns the URL to redirect the
 * browser to — Checkout is Stripe-hosted, so this app never touches a
 * card number.
 */
export async function createCheckoutSession(
  tenant: Tenant,
  opts: { successUrl: string; cancelUrl: string }
): Promise<string> {
  const stripe = getStripe();
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error("STRIPE_PRICE_ID is not configured — see .env.example.");

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    // Reuse the existing Stripe Customer if this tenant already has one
    // (e.g. they abandoned Checkout once already) rather than creating a
    // duplicate Customer object in Stripe on every retry.
    customer: tenant.stripeCustomerId ?? undefined,
    customer_email: tenant.stripeCustomerId ? undefined : tenant.signupEmail ?? undefined,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: { tenantId: tenant.id },
    },
    client_reference_id: tenant.id,
    metadata: { tenantId: tenant.id },
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout URL");
  return session.url;
}

/**
 * Stripe's own hosted "Manage billing" page — update card, view invoices,
 * cancel. Only usable once a tenant has an actual Stripe customer (i.e.
 * they've been through Checkout at least once); see routes/portal.ts's
 * /api/billing/portal-session for how the "incomplete" state is instead
 * routed back to createCheckoutSession above.
 */
export async function createBillingPortalSession(tenant: Tenant, returnUrl: string): Promise<string> {
  const stripe = getStripe();
  if (!tenant.stripeCustomerId) {
    throw new Error("This account hasn't completed billing setup yet — nothing to manage.");
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: tenant.stripeCustomerId,
    return_url: returnUrl,
  });
  return session.url;
}

/** Verifies + parses an incoming Stripe webhook payload. Throws on a bad/missing signature — the route handler turns that into a 400, same as Stripe's own recommended pattern. */
export function constructStripeEvent(rawBody: Buffer, signature: string | string[] | undefined): Stripe.Event {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured — see .env.example.");
  if (!signature || Array.isArray(signature)) throw new Error("Missing Stripe-Signature header");
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Whether a tenant in this local subscriptionStatus should be let into
 * the dashboard/API — the single source of truth for that decision, used
 * by routes/portal.ts's requireActiveBilling (the actual enforcement) and
 * by verify-billing.ts (so this can be tested without spinning up
 * Express). public/dashboard.html keeps its own client-side copy
 * (BILLING_OK_STATUSES) for UX purposes only, hand-kept in sync since
 * there's no shared module between server and a plain <script> tag — see
 * that file's comment.
 */
export function isBillingActive(status: Tenant["subscriptionStatus"]): boolean {
  return status === "trialing" || status === "active" || status === "exempt";
}

/**
 * Maps Stripe's own (wider) Subscription.status enum onto this app's
 * narrower local one — this app only ever acts on "does this tenant get
 * access or not," not on the finer distinctions between why they don't,
 * so `unpaid`/`incomplete_expired` fold into the closest local status
 * rather than being modeled one-for-one. Exported for verify-billing.ts.
 */
export function mapSubscriptionStatus(status: Stripe.Subscription.Status): Tenant["subscriptionStatus"] {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
      return "incomplete";
    default:
      return "past_due";
  }
}

/**
 * Applies a Stripe Subscription object's current state to whichever
 * tenant it belongs to — the single place that ever calls
 * db.tenant.updateBilling, so every webhook event that carries a
 * subscription (directly, or by fetching one via a linked id) funnels
 * through here rather than each event handler duplicating the same
 * lookup-then-write logic.
 *
 * Looks the tenant up by stripeSubscriptionId first (the normal case,
 * once a subscription has been seen before), falling back to
 * stripeCustomerId, then to the tenantId stashed in the subscription's
 * own metadata at creation time (see createCheckoutSession) — covers the
 * very first event for a brand new subscription, before either Stripe id
 * has been saved to this tenant's row yet.
 */
async function applySubscriptionToTenant(subscription: Stripe.Subscription): Promise<void> {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  let tenant =
    (await db.tenant.findByStripeSubscriptionId(subscription.id)) ||
    (await db.tenant.findByStripeCustomerId(customerId));
  if (!tenant) {
    const tenantId = subscription.metadata?.tenantId;
    if (tenantId) tenant = await db.tenant.findById(tenantId);
  }
  if (!tenant) {
    console.error(
      `[stripe] webhook for subscription ${subscription.id} (customer ${customerId}) doesn't match any known tenant — ignoring.`
    );
    return;
  }

  // current_period_end moved off the Subscription object itself onto each
  // line item as of this SDK/API version — this app only ever creates one
  // item per subscription (the flat plan), so items.data[0] is always the
  // one that matters.
  const periodEndSeconds = subscription.items.data[0]?.current_period_end;

  await db.tenant.updateBilling(tenant.id, {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: mapSubscriptionStatus(subscription.status),
    trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
    currentPeriodEnd: periodEndSeconds ? new Date(periodEndSeconds * 1000) : null,
  });
}

/**
 * The webhook event router — called by index.ts's /webhooks/stripe route
 * after signature verification. Covers the four event types the setup
 * instructions (.env.example, DIGITALOCEAN.md) tell you to subscribe the
 * endpoint to; any other event type is ignored rather than erroring, so
 * adding more event subscriptions in the Stripe dashboard later (for
 * something this app doesn't act on yet) can't break the endpoint.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription" || !session.subscription) break;
      const stripe = getStripe();
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : session.subscription.id;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await applySubscriptionToTenant(subscription);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await applySubscriptionToTenant(event.data.object as Stripe.Subscription);
      break;
    }
    case "invoice.payment_failed": {
      // Belt-and-braces: Stripe also moves the subscription itself to
      // past_due, which fires its own customer.subscription.updated event
      // — this reacts even in the edge case that event is ever missed or
      // delayed relative to this one. Newer API versions nest the
      // subscription under parent.subscription_details rather than a
      // top-level invoice.subscription field.
      const invoice = event.data.object as Stripe.Invoice;
      const linkedSub = invoice.parent?.subscription_details?.subscription;
      const subId = typeof linkedSub === "string" ? linkedSub : linkedSub?.id;
      if (!subId) break;
      const stripe = getStripe();
      const subscription = await stripe.subscriptions.retrieve(subId);
      await applySubscriptionToTenant(subscription);
      break;
    }
    default:
      break;
  }
}
