/**
 * Sets or changes the dashboard login (email + password) for a tenant —
 * needed for any CLI-onboarded tenant (add-tenant.ts), since that script
 * never sets signupEmail/passwordHash itself. Only the self-serve /signup
 * flow (lib/portal-signup.ts's provisionSelfServeTenant) does that
 * automatically. Without running this once, a consultancy client has no
 * way to log into /dashboard at all — /api/login checks signupEmail +
 * passwordHash directly (see routes/portal.ts), and both are NULL for a
 * freshly CLI-onboarded tenant.
 *
 * Run:
 *
 *   npm run set-tenant-login -- --tenant acme-co --email dan@automated-sales.co --password <a real password>
 *
 * Also doubles as a password-reset tool — same command, new password,
 * overwrites the old one. This is the manual answer to the punch list's
 * "password reset doesn't exist yet" item: there's still no self-serve
 * reset flow for a client who forgets their own password, but at least
 * onboarding no longer requires reaching into the DB by hand.
 *
 * Same single-process caution as add-tenant.ts/setup:pipedrive/
 * set-tenant-billing.ts: stop pm2 before running this, then start it
 * again after, so this script's write and the live server's in-memory
 * copy of the DB can't clobber each other on the next persist() —
 *   pm2 stop journey-tracker
 *   npm run set-tenant-login -- --tenant acme-co --email dan@automated-sales.co --password ...
 *   pm2 start journey-tracker
 */
import "dotenv/config";
import { db } from "./db";
import { hashPassword } from "./lib/auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = value;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.tenant || !args.email || !args.password) {
    console.error(
      "Usage: npm run set-tenant-login -- --tenant <slug> --email <login email> --password <a real password>"
    );
    process.exit(1);
  }

  if (!EMAIL_RE.test(args.email.trim())) {
    console.error(`"${args.email}" doesn't look like a valid email address.`);
    process.exit(1);
  }

  if (args.password.length < 8) {
    console.error("Password must be at least 8 characters (same minimum the self-serve signup form enforces).");
    process.exit(1);
  }

  const tenant = await db.tenant.findById(args.tenant);
  if (!tenant) {
    console.error(`No tenant found with slug "${args.tenant}". Run \`npm run list-tenants\` to see valid slugs.`);
    process.exit(1);
  }

  // Catches the case where this email is already used to log into a
  // *different* tenant — /api/login looks tenants up by signupEmail, so
  // two tenants sharing one email would make login ambiguous (whichever
  // row the lookup happens to return first "wins", silently).
  const existingOwner = await db.tenant.findBySignupEmail(args.email.trim());
  if (existingOwner && existingOwner.id !== tenant.id) {
    console.error(
      `"${args.email}" is already the login email for tenant "${existingOwner.id}" (${existingOwner.name}). Each login email must be unique across tenants — use a different email, or run this against tenant "${existingOwner.id}" if that's actually who you meant to update.`
    );
    process.exit(1);
  }

  const isChange = !!tenant.signupEmail;
  console.log(
    `"${tenant.name}" (${tenant.id}) — ${isChange ? `login email ${tenant.signupEmail} -> ${args.email}` : `setting login email -> ${args.email}`}`
  );

  await db.tenant.updateLogin(tenant.id, {
    signupEmail: args.email.trim(),
    passwordHash: hashPassword(args.password),
  });

  console.log(
    `\nDone. This tenant can now log in at https://attribution.automated-sales.co/login with:\n  email:    ${args.email.trim()}\n  password: (as given)\n\nRestart pm2 (\`pm2 start journey-tracker\` if you stopped it) if you haven't already.`
  );
}

main()
  .catch((err) => {
    console.error("set-tenant-login failed:", err.message || err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
