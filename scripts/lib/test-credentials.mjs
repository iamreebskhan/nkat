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
 * The harness account's password, from the environment only.
 *
 * Exits rather than defaulting. A default here is a credential in git that
 * works against production, and the convenience of not having to type it is
 * not worth that. See the runbook's "Harness account" preamble, or:
 *
 *   read -rs -p 'harness password: ' TEST_PASSWORD; export TEST_PASSWORD; echo
 *
 * Scripts call harnessAccount(), not this. On its own it checks that a
 * password exists and nothing about whose account it unlocks.
 */
export function requireDemoPassword() {
  const pw = process.env.TEST_PASSWORD;
  if (!pw) {
    console.error(
      "TEST_PASSWORD is not set.\n" +
        "This script signs in as the harness account and will not carry a\n" +
        "default password in the repository. Provide it for this shell with:\n\n" +
        "  read -rs -p 'harness password: ' TEST_PASSWORD; export TEST_PASSWORD; echo\n",
    );
    process.exit(2);
  }
  return pw;
}

/**
 * Who harness scripts sign in as (R36).
 *
 * Eight scripts used to default to livedemo@pallio.io in 'Pallio Live Demo',
 * the production tenant about to be handed to a prospect as the demo login.
 * Every runbook pass wrote another patient, a visit booked past the capacity
 * guard with confirmDoubleBook, a superbill and a denial into it, and the
 * six-year audit retention trigger means none of that trail can be removed.
 *
 * So the default is a dedicated org whose only member is on the reserved test
 * domain. .test is reserved by RFC 2606 and cannot be a real address, which is
 * the same fact 0085 and 0086 use to recognise a test org.
 */
export const HARNESS_EMAIL = "harness@pallio-smoke.test";
export const HARNESS_ORG = "Pallio Harness";
export const HARNESS_FULL_NAME = "Harness Runner";

/**
 * The demo tenant, matched by pattern rather than by exact value, so the
 * guard covers the old login and every seat on the tenant that replaces it
 * (R20 puts its staff on @demo.pallio.io). TEST_EMAIL and TEST_ORG can still
 * point the scripts at any other account, just not at this one.
 */
export const DEMO_TENANT_EMAIL = /^livedemo@pallio\.io$|[@.]demo\.pallio\.io$/i;
/** 'Pallio Live Demo', R20's 'Pallio Demo Palliative Care', and their slugs. */
export const DEMO_TENANT_ORG = /pallio[\s_-]*(?:live[\s_-]*)?demo/i;

function refuseDemoTenant(value, pattern) {
  if (!pattern.test(value)) return;
  console.error(
    `refusing: ${value} is the demo tenant — harness scripts never write there.\n` +
      `Unset TEST_EMAIL / TEST_ORG to use ${HARNESS_EMAIL} in '${HARNESS_ORG}'.\n`,
  );
  process.exit(2);
}

/**
 * The identity a harness script signs up or logs in with, checked before the
 * script sends anything.
 *
 * The tenant check runs before the password check, so a run aimed at the
 * demo tenant is told why it was refused even when no password is set. If it
 * ran second, that run would exit 2 for the wrong reason. Either failure
 * exits 2 before the script has made a request.
 */
export function harnessAccount() {
  const email = (process.env.TEST_EMAIL || HARNESS_EMAIL).trim();
  const orgName = (process.env.TEST_ORG || HARNESS_ORG).trim();
  refuseDemoTenant(email, DEMO_TENANT_EMAIL);
  refuseDemoTenant(orgName, DEMO_TENANT_ORG);
  return { email, orgName, fullName: HARNESS_FULL_NAME, password: requireDemoPassword() };
}
