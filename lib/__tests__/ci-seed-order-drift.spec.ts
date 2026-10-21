/**
 * CI must build the database production runs, not the one the filesystem
 * happens to hand it.
 *
 * WHAT WENT WRONG. Both database-building jobs in .github/workflows/ci.yml
 * applied seeds with `for f in db/seed/*.sql`. Rule seeds expire the rows they
 * supersede and then revive their own with
 * ON CONFLICT (id) DO UPDATE ... expiration_date = NULL, so whichever of two
 * seeds sharing a key runs LAST wins. In ASCII order '-' (0x2D) sorts before
 * '.' (0x2E), which put payer-rules-denial-attributes-2.sql (round 2) BEFORE
 * payer-rules-denial-attributes.sql (round 1) on a C/C.UTF-8 runner. CI
 * therefore validated a rule library with round 1 live on all 28 keys the two
 * share, while production — which walks db/seed/MANIFEST through
 * scripts/deploy.sh — served round 2. That is bit for bit the incident round
 * 1's own header records: "production quietly served the OLDER
 * UnitedHealthcare Ohio rule ... No error anywhere; the row counts were all
 * correct." Glob order also ran the ingestion seeds before payer-medicare.sql,
 * so every Medicare ingestion source in CI was written with payer_id NULL.
 *
 * WHAT THIS FILE GUARDS, AND WHAT IT DOES NOT. This is an INVENTORY and
 * ORDERING check over the two files CI reads: db/seed/MANIFEST and ci.yml. It
 * fails when a seed exists that neither accounts for, when a file is claimed by
 * both, when a run step goes back to globbing db/seed, and when the order the
 * two files imply breaks one of the dependencies below.
 *
 * It deliberately does NOT try to prove the resulting database is correct —
 * asserting that from JavaScript would mean restating the supersession rule,
 * which is the failure mode this whole audit exists to close. That proof is
 * db/test/0003_rule_supersession.sql, which CI runs against the real database
 * it just built and which reads the ANSWER TEXT a biller acts on.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "..", "..");
const SEED_DIR = join(REPO, "db", "seed");
const CI_YML = join(REPO, ".github", "workflows", "ci.yml");

const CI = readFileSync(CI_YML, "utf8");
const MANIFEST_RAW = readFileSync(join(SEED_DIR, "MANIFEST"), "utf8");

/** The manifest walk, parsed the way scripts/deploy.sh and ci.yml parse it. */
const MANIFEST_SEEDS = MANIFEST_RAW.split(/\r?\n/)
  .map((l) => l.replace(/#.*/, "").trim())
  .filter((l) => l.length > 0);

const SEED_FILES = readdirSync(SEED_DIR).filter((f) => f.endsWith(".sql"));

/**
 * Every `run: |` block in ci.yml, dedented, so the shell can be read as shell.
 */
function runBlocks(): { line: number; text: string }[] {
  const lines = CI.split(/\r?\n/);
  const blocks: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*run:\s*\|\s*$/.test(lines[i])) continue;
    const indent = lines[i].match(/^\s*/)![0].length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") {
        body.push("");
        continue;
      }
      if (l.match(/^\s*/)![0].length <= indent) break;
      body.push(l);
    }
    const widths = body.filter((b) => b.trim()).map((b) => b.match(/^\s*/)![0].length);
    const min = widths.length ? Math.min(...widths) : 0;
    blocks.push({ line: i + 1, text: body.map((b) => b.slice(min)).join("\n") });
  }
  return blocks;
}

/** The steps that build a database out of db/seed. There are two: the
 *  backend-integration job and the schema-apply job. */
const SEED_STEPS = runBlocks().filter((b) => /db\/seed/.test(b.text));

/** A shell block with its whole-line `#` comments dropped. The comments in
 *  ci.yml quote the banned `for f in db/seed/*.sql` loop to explain why it is
 *  banned, and the first version of this file failed on its own explanation. */
function shellCode(block: string): string {
  return block
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

function shellList(block: string, name: string): string[] {
  const m = block.match(new RegExp(`${name}="([^"]*)"`));
  if (!m) return [];
  return m[1].split(/\s+/).filter(Boolean);
}

/** SQL with `--` line comments removed, so a table named in prose is not
 *  mistaken for a table the seed actually touches. ingestion-source-medicare-pdf.sql
 *  explains payer_rule in its header without ever reading or writing it. */
function sqlBody(file: string): string {
  return readFileSync(join(SEED_DIR, file), "utf8").replace(/--[^\n]*/g, "");
}

describe("ci.yml seed application", () => {
  it("has at least one step that builds a database from db/seed", () => {
    // If this ever reaches zero the parser has drifted, and every assertion
    // below would pass against nothing.
    expect(SEED_STEPS.length).toBeGreaterThan(0);
  });

  it("never applies db/seed in filesystem order", () => {
    for (const step of SEED_STEPS) {
      const code = shellCode(step.text);
      expect(
        /db\/seed\/\*\.sql/.test(code),
        `ci.yml:${step.line} globs db/seed/*.sql. Filesystem order puts payer-rules-denial-attributes-2.sql before payer-rules-denial-attributes.sql, which leaves round 1 live on the 28 keys they share.`,
      ).toBe(false);
      expect(
        /MANIFEST/.test(code),
        `ci.yml:${step.line} applies seeds without reading db/seed/MANIFEST, so the order it builds is not the order scripts/deploy.sh applies to production.`,
      ).toBe(true);
    }
  });

  it("declares the same fixture lists in every database-building step", () => {
    // The block is duplicated per job because a composite action would be a
    // separate file. Duplicated text drifts; this is what notices.
    const before = SEED_STEPS.map((s) => shellList(s.text, "FIXTURES_BEFORE_RULES").join(" "));
    const after = SEED_STEPS.map((s) => shellList(s.text, "FIXTURES_AFTER_RULES").join(" "));
    expect(new Set(before).size, `steps disagree on FIXTURES_BEFORE_RULES: ${before.join(" | ")}`).toBe(1);
    expect(new Set(after).size, `steps disagree on FIXTURES_AFTER_RULES: ${after.join(" | ")}`).toBe(1);
    expect(before[0]!.length, "no FIXTURES_BEFORE_RULES declared").toBeGreaterThan(0);
  });
});

/**
 * A TS string-array constant, e.g. `export const X = ['a.sql', 'b.sql'];`.
 * harness.ts cannot be imported here — it pulls testcontainers and pg from
 * backend/node_modules — so its two lists are read as text, which is enough to
 * hold them against ci.yml's.
 */
function tsList(src: string, name: string): string[] {
  const m = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/**
 * The fourth database builder. CI's jest step runs this harness with
 * INTEGRATION=1, and it used to apply readdirSync(db/seed).sort() — the glob
 * order this file bans in ci.yml — AND feed tenant-demo-palliative.sql, a psql
 * script, to pool.query, which fails on its first \set. Either one failed the
 * backend-integration job on push.
 */
describe("backend/test/integration/harness.ts", () => {
  const HARNESS = readFileSync(join(REPO, "backend", "test", "integration", "harness.ts"), "utf8");
  // Code only: the harness's own comments quote the banned
  // readdirSync(SEED_DIR).sort() to explain why it is banned.
  const code = HARNESS.split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l))
    .join("\n");
  const ciBefore = shellList(SEED_STEPS[0]?.text ?? "", "FIXTURES_BEFORE_RULES");
  const ciAfter = shellList(SEED_STEPS[0]?.text ?? "", "FIXTURES_AFTER_RULES");

  it("never applies db/seed in filesystem order", () => {
    expect(
      /readdirSync\(\s*SEED_DIR\s*\)/.test(code),
      "harness.ts reads db/seed with readdirSync again, which is filesystem order",
    ).toBe(false);
    expect(/seedFiles\(\)/.test(code), "harness.ts no longer applies seedFiles()").toBe(true);
  });

  it("places the same fixtures before the rule library as ci.yml does", () => {
    expect(ciBefore.length, "ci.yml's FIXTURES_BEFORE_RULES did not parse").toBeGreaterThan(0);
    expect(tsList(HARNESS, "FIXTURES_BEFORE_RULES")).toEqual(ciBefore);
  });

  it("names ci.yml's after-library fixtures as the ones it leaves to psql", () => {
    expect(tsList(HARNESS, "FIXTURES_AFTER_RULES_PSQL_ONLY")).toEqual(ciAfter);
  });

  it("feeds pool.query only seeds pool.query can run", () => {
    // The failure that shipped: a psql meta-command reaching pool.query fails
    // with a syntax error at the backslash. Every seed the harness applies —
    // the manifest plus the before-library fixtures — must be plain SQL, so
    // adding a psql-only seed to MANIFEST fails here, not in CI.
    const applied = [...MANIFEST_SEEDS, ...ciBefore];
    const offenders = applied.filter((f) =>
      /^\s*\\[a-zA-Z]/m.test(readFileSync(join(SEED_DIR, f), "utf8")),
    );
    expect(offenders, `harness.ts would feed these psql scripts to pool.query: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("db/seed inventory", () => {
  const fixturesBefore = shellList(SEED_STEPS[0]?.text ?? "", "FIXTURES_BEFORE_RULES");
  const fixturesAfter = shellList(SEED_STEPS[0]?.text ?? "", "FIXTURES_AFTER_RULES");
  const fixtures = [...fixturesBefore, ...fixturesAfter];

  it("accounts for every seed file exactly once", () => {
    const applied = [...MANIFEST_SEEDS, ...fixtures];
    const missing = SEED_FILES.filter((f) => !applied.includes(f));
    // A seed nobody applies is a seed nobody proves. This is the check that
    // fires when the next seed is added and only the deploy is told about it.
    expect(
      missing,
      `these db/seed files are in neither db/seed/MANIFEST nor ci.yml's fixture lists, so CI never applies them: ${missing.join(", ")}`,
    ).toEqual([]);

    const duplicated = applied.filter((f, i) => applied.indexOf(f) !== i);
    expect(
      duplicated,
      `applied more than once, which re-runs a supersession pass at the wrong point: ${duplicated.join(", ")}`,
    ).toEqual([]);
  });

  it("names no file that is not there", () => {
    const applied = [...MANIFEST_SEEDS, ...fixtures];
    const ghosts = applied.filter((f) => !SEED_FILES.includes(f));
    expect(ghosts, `named for application but absent from db/seed/: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("keeps the CI-only fixtures out of the manifest", () => {
    // MANIFEST is what reaches production. A fixture listed there would put
    // synthetic Medicare rules, test users or a demo tenant into a customer's
    // database; deploy.sh's tenant-writer check would die on some of them, and
    // the rest would apply silently.
    const both = fixtures.filter((f) => MANIFEST_SEEDS.includes(f));
    expect(both, `listed in db/seed/MANIFEST and applied again as a CI fixture: ${both.join(", ")}`).toEqual([]);
  });
});

describe("the order db/seed/MANIFEST and ci.yml imply", () => {
  const fixturesBefore = shellList(SEED_STEPS[0]?.text ?? "", "FIXTURES_BEFORE_RULES");
  const fixturesAfter = shellList(SEED_STEPS[0]?.text ?? "", "FIXTURES_AFTER_RULES");

  // ci.yml splices the fixtures in at the first payer-rules-* entry. That
  // split point only means anything if the rule library is the tail of the
  // manifest; a reference seed appended after it would be applied AFTER the
  // fixtures that depend on it.
  const firstRuleIdx = MANIFEST_SEEDS.findIndex((f) => f.startsWith("payer-rules-"));

  const applied = [
    ...MANIFEST_SEEDS.slice(0, firstRuleIdx),
    ...fixturesBefore,
    ...MANIFEST_SEEDS.slice(firstRuleIdx),
    ...fixturesAfter,
  ];
  const at = (f: string) => applied.indexOf(f);

  it("keeps the rule library contiguous at the end of the manifest", () => {
    expect(firstRuleIdx, "db/seed/MANIFEST lists no payer-rules-* seed at all").toBeGreaterThan(-1);
    const strays = MANIFEST_SEEDS.slice(firstRuleIdx).filter((f) => !f.startsWith("payer-rules-"));
    expect(
      strays,
      `these manifest entries sit after the rule library starts, so ci.yml would apply the CI fixtures before them: ${strays.join(", ")}`,
    ).toEqual([]);
  });

  it("applies the denial-attributes rounds in the order the manifest fixes", () => {
    // Round 2 supersedes round 1 on 28 shared keys and must therefore run
    // second. ASCII sorting inverts exactly this pair, which is how the
    // production incident happened.
    const r1 = at("payer-rules-denial-attributes.sql");
    const r2 = at("payer-rules-denial-attributes-2.sql");
    expect(r1, "payer-rules-denial-attributes.sql is not applied").toBeGreaterThan(-1);
    expect(r2, "payer-rules-denial-attributes-2.sql is not applied").toBeGreaterThan(-1);
    expect(r1, "round 1 must be applied before round 2, or round 1 wins on all 28 shared keys").toBeLessThan(r2);
  });

  it("creates the Medicare payer before any seed that looks it up by name", () => {
    // ingestion-sources-cms.sql resolves the payer with
    // SELECT id FROM payer WHERE name ILIKE '%medicare%' and writes NULL when
    // that finds nothing — legal, silent, and it leaves the source inert
    // because ingestDocumentFromUrl needs both payer_id and state.
    const CREATOR = "payer-medicare.sql";
    const lookups = SEED_FILES.filter(
      (f) => f !== CREATOR && /ILIKE\s*'%medicare%'/i.test(sqlBody(f)),
    ).filter((f) => at(f) > -1);
    expect(lookups.length, "no seed resolves Medicare by name any more — this check is moot").toBeGreaterThan(0);
    for (const f of lookups) {
      expect(
        at(CREATOR),
        `${f} resolves Medicare by name but is applied before ${CREATOR} creates it, so its payer_id is written NULL`,
      ).toBeLessThan(at(f));
    }
  });

  it("applies a payer_rule-writing fixture before the rule library, and a payer_rule-reading one after", () => {
    const firstRule = at(MANIFEST_SEEDS[firstRuleIdx]!);
    const lastRule = Math.max(
      ...MANIFEST_SEEDS.filter((f) => f.startsWith("payer-rules-")).map((f) => at(f)),
    );
    const fixtures = [...fixturesBefore, ...fixturesAfter];

    const writers = fixtures.filter((f) => /INSERT\s+INTO\s+payer_rule/i.test(sqlBody(f)));
    expect(writers.length, "no CI fixture writes payer_rule any more — this check is moot").toBeGreaterThan(0);
    for (const f of writers) {
      // A fixture applied after the library leaves its rows live alongside the
      // library's on every key they share, and fetchPayerRule ends in LIMIT 1,
      // so the answer a clinician sees would depend on row order.
      expect(
        at(f),
        `${f} writes payer_rule but is applied after the rule library, leaving two live rules on every key they share`,
      ).toBeLessThan(firstRule);
    }

    const readers = fixtures.filter(
      (f) => !writers.includes(f) && /(FROM|JOIN)\s+payer_rule\b/i.test(sqlBody(f)),
    );
    expect(readers.length, "no CI fixture reads payer_rule any more — this check is moot").toBeGreaterThan(0);
    for (const f of readers) {
      // tenant-demo-palliative.sql prices its demo superbills from the payer
      // fee schedule. Applied before the library it would price them from an
      // empty table and every demo line would come out 'unrated'.
      expect(
        at(f),
        `${f} reads payer_rule but is applied before the rule library finishes, so it reads an incomplete library`,
      ).toBeGreaterThan(lastRule);
    }
  });
});
