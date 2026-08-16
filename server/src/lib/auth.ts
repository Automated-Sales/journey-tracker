import crypto from "crypto";
import { Request, Response } from "express";

/**
 * Password hashing for the self-serve portal login. Deliberately built on
 * Node's built-in crypto.scrypt rather than bcrypt/argon2 packages — every
 * native-binary dependency tried in this project so far (Prisma, then
 * better-sqlite3) failed to install in this sandbox because their
 * postinstall step downloads a prebuilt binary from a host this network
 * can't reach. scrypt is slow-by-design (same goal as bcrypt: expensive to
 * brute-force) and ships in Node itself, so there's nothing to install.
 */
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored || !stored.includes(":")) return false;
  const [salt, derivedHex] = stored.split(":");
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const stored_ = Buffer.from(derivedHex, "hex");
  // Constant-time compare — a plain `===` on the hex strings would leak
  // timing information about how many leading bytes matched.
  if (derived.length !== stored_.length) return false;
  return crypto.timingSafeEqual(derived, stored_);
}

// ---------------------------------------------------------------------
// Session cookie — minimal hand-rolled parse/set instead of pulling in
// cookie-parser, to keep this project's zero-new-dependency streak (see
// hashPassword above for why that matters in this sandbox specifically;
// it's a nice-to-have everywhere else). One cookie, one purpose: carry the
// opaque session token from db.session; the token itself is the only
// thing that needs to be unguessable (crypto.randomBytes(32) — see
// db.ts), not the cookie mechanics.
// ---------------------------------------------------------------------

export const SESSION_COOKIE_NAME = "as_portal_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function getSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rawVal] = part.trim().split("=");
    if (rawKey === SESSION_COOKIE_NAME) {
      return decodeURIComponent(rawVal.join("="));
    }
  }
  return null;
}

export function setSessionCookie(res: Response, token: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}${secure}`
  );
}

export function clearSessionCookie(res: Response) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
