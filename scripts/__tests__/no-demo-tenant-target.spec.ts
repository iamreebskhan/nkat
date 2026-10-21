/**
 * No harness script may aim at the demo tenant (R36).
 *
 * Eight scripts defaulted to livedemo@pallio.io in 'Pallio Live Demo', the
 * production tenant a prospect is about to be given, and every runbook pass
 * wrote patients, visits, superbills and denials into it. They now take their
 * identity from harnessAccount() in scripts/lib/test-credentials.mjs, which
 * refuses the demo tenant. These checks stop the next script, or the next
 * copy of an old one, from going around it:
 *
 *   - no script names the demo tenant;
 *   - only the credentials module reads TEST_EMAIL, TEST_ORG or TEST_PASSWORD,
 *     because that is where the guard lives;
 *   - no script imports requireDemoPassword on its own, since that unlocks an
 *     account without asking whose it is;
 *   - a script that signs in with the TEST_* identity gets it from
 *     harnessAccount().
 *
 * Against the tree before R36 each of those fails, naming the same eight
 * files. The controls at the bottom run every pattern against the old line
 * shapes, so a pass cannot come from a pattern that matches nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPTS_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Top-level scripts, the ones the runbook runs. lib/ holds the guard itself. */
const scripts = readdirSync(SCRIPTS_DIR)
  .filter((f) => /\.(?:mjs|js|ts|sh)$/.test(f))
  .map((file) => ({ file, src: readFileSync(join(SCRIPTS_DIR, file), "utf8") }));

/** The scripts R36 converted. Named, so a scan that finds nothing cannot pass. */
const CONVERTED = [
  "e2e-exhaustive-ui.mjs",
  "e2e-live-walkthrough.mjs",
  "ingest-full-rule-chunked.mjs",
  "probe-live-account.mjs",
  "verify-demo-user-medicare.mjs",
  "verify-master-ui.mjs",
  "verify-medicare-extraction.mjs",
  "verify-scan-fixes.mjs",
];

const NAMES_DEMO_TENANT = /livedemo@pallio\.io|pallio live demo|@demo\.pallio\.io/i;
const READS_IDENTITY_ENV =
  /process\.env(?:\.|\[\s*["'])TEST_(?:EMAIL|ORG|PASSWORD)\b|\{[^}]*\bTEST_(?:EMAIL|ORG|PASSWORD)\b[^}]*\}\s*=\s*process\.env\b/;
const IMPORTS_BARE_PASSWORD = /import\s*\{[^}]*\brequireDemoPassword\b[^}]*\}\s*from/;
const IMPORTS_HARNESS =
  /import\s*\{[^}]*\bharnessAccount\b[^}]*\}\s*from\s*["']\.\/lib\/test-credentials\.mjs["']/;
const MENTIONS_TEST_IDENTITY = /\bTEST_(?:EMAIL|PASSWORD)\b/;
const SIGNS_IN = /\/api\/auth\/(?:signup|login)\b|\$\{BASE\}\/login\b/;

const matching = (re: RegExp) => scripts.filter((s) => re.test(s.src)).map((s) => s.file);

describe("harness scripts and the demo tenant", () => {
  it("scans the scripts the runbook runs", () => {
    const scanned = scripts.map((s) => s.file);
    for (const f of CONVERTED) expect(scanned).toContain(f);
  });

  it("no script names the demo tenant", () => {
    expect(matching(NAMES_DEMO_TENANT)).toEqual([]);
  });

  it("only the credentials module reads TEST_EMAIL / TEST_ORG / TEST_PASSWORD", () => {
    expect(matching(READS_IDENTITY_ENV)).toEqual([]);
  });

  it("no script imports requireDemoPassword around the tenant guard", () => {
    expect(matching(IMPORTS_BARE_PASSWORD)).toEqual([]);
  });

  it("every script that signs in with the TEST_* identity gets it from harnessAccount()", () => {
    const unguarded = scripts
      .filter((s) => SIGNS_IN.test(s.src) && MENTIONS_TEST_IDENTITY.test(s.src))
      .filter((s) => !IMPORTS_HARNESS.test(s.src))
      .map((s) => s.file);
    expect(unguarded).toEqual([]);
    const src = (f: string) => scripts.find((s) => s.file === f)?.src ?? "";
    expect(CONVERTED.filter((f) => !IMPORTS_HARNESS.test(src(f)))).toEqual([]);
  });

  describe("controls: each pattern catches the pre-R36 line shapes", () => {
    it.each([
      [NAMES_DEMO_TENANT, 'const EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";'],
      [NAMES_DEMO_TENANT, 'fullName: "Live Tester", orgName: "Pallio Live Demo", baaAccepted: true'],
      [NAMES_DEMO_TENANT, 'TEST_EMAIL: "dr.x@demo.pallio.io"'],
      [READS_IDENTITY_ENV, 'const EMAIL = process.env.TEST_EMAIL || "someone@pallio-smoke.test";'],
      [READS_IDENTITY_ENV, 'const ORG = process.env["TEST_ORG"];'],
      [READS_IDENTITY_ENV, "const { TEST_PASSWORD: pw } = process.env;"],
      [IMPORTS_BARE_PASSWORD, 'import { requireDemoPassword } from "./lib/test-credentials.mjs";'],
      [SIGNS_IN, 'await req("POST", "/api/auth/signup", { email: EMAIL });'],
      [SIGNS_IN, "await page.goto(`${BASE}/login`);"],
    ])("%s catches: %s", (re, line) => {
      expect(re.test(line)).toBe(true);
    });

    it("and pass the converted shape", () => {
      const converted =
        'import { harnessAccount } from "./lib/test-credentials.mjs";\n' +
        "const { email: EMAIL, password: PASSWORD } = harnessAccount();";
      expect(IMPORTS_HARNESS.test(converted)).toBe(true);
      expect(NAMES_DEMO_TENANT.test(converted)).toBe(false);
      expect(READS_IDENTITY_ENV.test(converted)).toBe(false);
      expect(IMPORTS_BARE_PASSWORD.test(converted)).toBe(false);
    });
  });
});
