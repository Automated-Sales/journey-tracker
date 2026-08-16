import crypto from "crypto";
import { db, Tenant } from "../db";
import { hashPassword } from "./auth";
import { PipedriveMe } from "./pipedrive";

/**
 * The tenant-provisioning half of self-serve signup, kept separate from
 * the actual Pipedrive network call (getMe) so it's testable with a fake
 * `me` result — see verify-portal.ts. The route handler (routes/portal.ts)
 * is the only place that does the real `getMe(token)` HTTP call; everything
 * here is pure DB writes given already-validated inputs.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateSignupForm(form: {
  companyName?: string;
  email?: string;
  password?: string;
  pipedriveToken?: string;
}): string | null {
  if (!form.companyName || !form.companyName.trim()) return "Company name is required.";
  if (!form.email || !EMAIL_RE.test(form.email.trim())) return "A valid email address is required.";
  if (!form.password || form.password.length < 8) return "Password must be at least 8 characters.";
  if (!form.pipedriveToken || !form.pipedriveToken.trim()) return "Your Pipedrive API token is required.";
  return null;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "client";
}

async function uniqueTenantId(companyName: string): Promise<string> {
  const base = slugify(companyName);
  let candidate = base;
  let n = 2;
  // Small, bounded loop against a low-cardinality slug space — fine to do
  // sequentially rather than optimistically, signups aren't high enough
  // volume for this to matter.
  while (await db.tenant.findById(candidate)) {
    candidate = `${base}-${n}`;
    n++;
  }
  return candidate;
}

function randomKey(bytes: number) {
  return crypto.randomBytes(bytes).toString("hex");
}

export async function provisionSelfServeTenant(params: {
  companyName: string;
  email: string;
  password: string;
  pipedriveToken: string;
  me: PipedriveMe;
}): Promise<Tenant> {
  const existing = await db.tenant.findBySignupEmail(params.email);
  if (existing) {
    throw new Error("An account with this email already exists. Try logging in instead.");
  }

  const id = await uniqueTenantId(params.companyName);

  return db.tenant.create({
    id,
    name: params.companyName.trim(),
    pipedriveApiToken: params.pipedriveToken.trim(),
    pipedriveCompanyDomain: params.me.companyDomain,
    trackKey: randomKey(16),
    webhookSecret: randomKey(16),
    signupEmail: params.email.trim(),
    passwordHash: hashPassword(params.password),
    signupSource: "self_serve",
  });
}
