/**
 * Credentials for scripts that sign up against a running Pallio.
 *
 * WHY THIS EXISTS
 *
 * These scripts used to build a password out of the same Date.now() stamp
 * they put in the org name:
 *
 *   const s = Date.now();
 *   orgName:  `FB ${s}`            -> shown in /admin/orgs
 *   email:    `fb-${s}@pallio-smoke.test`
 *   password: `Fb-${s}!x`
 *
 * The org name is displayed on the platform-admin orgs page. Anyone who can
 * read it can compute the password, because the password is a pure function
 * of the visible half. Production had 29 such accounts, created between
 * 2026-05-21 and 2026-08-19 by scripts that never cleaned up after
 * themselves, each with a patient and a visit attached.
 *
 * The stamp is fine for the EMAIL and the ORG NAME — those only need to be
 * unique, and being able to read them off a screen is the point. It is not
 * fine for the secret. So the secret is random and never derived from
 * anything the script also publishes.
 *
 * The other half of this: a hard-coded fallback password for the shared demo
 * account, committed to the repo and valid against production. Scripts that
 * need it now demand it from the environment and stop if it is missing,
 * rather than quietly reaching for a published string.
 */
import { randomBytes } from "node:crypto";

/**
 * A password for an account this script is about to create.
 *
 * Shaped to satisfy lib/features/auth/password-policy.ts without tripping
 * its screens: comfortably over the 12-character minimum, mixed case and
 * digits from base64url, and no relation to the email, the org name, or any
 * dictionary base. Never printed — a run that needs to log back in should
 * hold this value, not echo it into a log.
 */
export function randomTestPassword() {
  return `Tp${randomBytes(18).toString("base64url")}9aZ!`;
}

/**
 * The shared demo account's password, from the environment only.
 *
 * Throws rather than defaulting. A default here is a credential in git that
 * works against production, and the convenience of not having to type it is
 * not worth that. See the runbook, or:
 *
 *   read -rs -p 'demo password: ' TEST_PASSWORD; export TEST_PASSWORD; echo
 */
export function requireDemoPassword() {
  const pw = process.env.TEST_PASSWORD;
  if (!pw) {
    console.error(
      "TEST_PASSWORD is not set.\n" +
        "This script signs in as the shared demo account and will not carry a\n" +
        "default password in the repository. Provide it for this shell with:\n\n" +
        "  read -rs -p 'demo password: ' TEST_PASSWORD; export TEST_PASSWORD; echo\n",
    );
    process.exit(2);
  }
  return pw;
}
