import { Request, Response, NextFunction, RequestHandler } from "express";
import { db, Tenant } from "../db";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
}

/**
 * Every route in this app is mounted under /t/:tenant (see index.ts).
 * This middleware resolves that slug to a real Tenant row and attaches
 * it to req.tenant — every downstream handler reads req.tenant instead
 * of any global config, since there is no "the" Pipedrive account
 * anymore, only "this client's" Pipedrive account.
 */
export const requireTenant: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const slug = req.params.tenant;
  if (!slug) return res.status(400).json({ error: "Missing tenant slug in URL (expected /t/:tenant/...)" });

  const tenant = await db.tenant.findById(slug);
  if (!tenant) return res.status(404).json({ error: `Unknown tenant "${slug}"` });

  req.tenant = tenant;
  next();
};

/**
 * For the endpoints exposed to a browser (tracking snippet) or an
 * outside webhook sender: requires a matching key/secret in addition to
 * a valid tenant slug, so one client can't spam or read another
 * client's data just by guessing a slug. Pass the query-param name to
 * check ("key" for the snippet's public-ish track key, "secret" for
 * webhook senders).
 */
export function requireTenantSecret(paramName: "key" | "secret", tenantField: "trackKey" | "webhookSecret"): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const tenant = req.tenant;
    if (!tenant) return res.status(500).json({ error: "requireTenant must run before requireTenantSecret" });
    const provided = (req.query[paramName] as string) || (req.headers["x-tenant-secret"] as string);
    if (provided !== tenant[tenantField]) {
      return res.status(401).json({ error: `Missing or incorrect ${paramName} for tenant "${tenant.id}"` });
    }
    next();
  };
}
