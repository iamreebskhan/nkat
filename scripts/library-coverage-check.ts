/**
 * Rule-library coverage guard.
 *
 *   npx tsx scripts/library-coverage-check.ts            # report
 *   npx tsx scripts/library-coverage-check.ts --snapshot # write baseline
 *   npx tsx scripts/library-coverage-check.ts --check    # fail on regression
 *
 * WHY THIS EXISTS
 * The library sat with rules for 3 of 19 payers for months. Nothing was
 * broken in a way any test could see: every query returned successfully,
 * every page rendered, all 309 unit tests passed. The failure was an
 * ABSENCE, and absences do not throw.
 *
 * So this asserts on absence. `--check` compares live coverage against
 * the committed baseline and exits non-zero if any payer answers fewer
 * core codes than it did before — which is what a bad migration, a
 * mis-scoped retraction, or a botched re-ingest actually looks like.
 *
 * Run it in CI after migrations, and on the VPS after a deploy.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { getCoverageMatrix, getLibrarySummary, getSourceHealth } from
  "@/lib/features/ingestion/library-health.service";

const BASELINE = join(process.cwd(), "db", "library-coverage-baseline.json");

type Baseline = {
  capturedAt: string;
  coreCodeCoveragePct: number;
  perPayer: Record<string, number>;
};

async function main() {
  const mode = process.argv.includes("--snapshot") ? "snapshot"
    : process.argv.includes("--check") ? "check" : "report";

  const [summary, coverage, sources] = await Promise.all([
    getLibrarySummary(), getCoverageMatrix(), getSourceHealth(),
  ]);

  console.log("\n=== RULE LIBRARY ===");
  console.log(`  payers                    ${summary.payersTotal}`);
  console.log(`  with at least one rule    ${summary.payersWithAnyRule}`);
  console.log(`  with NO rule              ${summary.payersWithNoRule}`);
  console.log(`  with NO source registered ${summary.payersWithNoSource}`);
  console.log(`  live rules                ${summary.liveRules}`);
  console.log(`  core-code coverage        ${summary.coreCodeCoveragePct}%`);

  const attention = sources.filter((s) => s.active && s.status !== "ok");
  console.log(`\n=== SOURCES: ${summary.sourcesActive} active, ${attention.length} need attention ===`);
  for (const s of attention) {
    console.log(`  [${s.status.padEnd(14)}] ${s.name}`);
    console.log(`                    ${s.detail}`);
  }
  if (!attention.length) console.log("  all healthy");

  console.log("\n=== COVERAGE BY PAYER (core codes) ===");
  for (const c of coverage) {
    const bar = `${c.coreCodesCovered}/${c.coreCodesTargeted}`;
    const flag = c.coreCodesCovered === 0
      ? (c.sourceCount === 0 ? "  <- no rules, NO SOURCE REGISTERED" : "  <- no rules (source registered, not yet ingested)")
      : "";
    console.log(`  ${bar.padEnd(6)} ${c.payerName.padEnd(44)} ${String(c.totalRules).padStart(5)} rules${flag}`);
  }

  if (mode === "snapshot") {
    const b: Baseline = {
      capturedAt: new Date().toISOString(),
      coreCodeCoveragePct: summary.coreCodeCoveragePct,
      perPayer: Object.fromEntries(coverage.map((c) => [c.payerName, c.coreCodesCovered])),
    };
    writeFileSync(BASELINE, JSON.stringify(b, null, 2) + "\n");
    console.log(`\nbaseline written -> ${BASELINE}`);
    return;
  }

  if (mode === "check") {
    if (!existsSync(BASELINE)) {
      console.log("\nno baseline committed yet — run with --snapshot first. Not failing.");
      return;
    }
    const b: Baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    const regressions: string[] = [];
    for (const c of coverage) {
      const was = b.perPayer[c.payerName];
      if (was !== undefined && c.coreCodesCovered < was) {
        regressions.push(`  ${c.payerName}: ${was} -> ${c.coreCodesCovered} core codes`);
      }
    }
    // A payer disappearing entirely is a regression too.
    for (const name of Object.keys(b.perPayer)) {
      if (!coverage.some((c) => c.payerName === name) && b.perPayer[name] > 0) {
        regressions.push(`  ${name}: payer no longer present (had ${b.perPayer[name]} core codes)`);
      }
    }

    if (regressions.length) {
      console.error(`\nCOVERAGE REGRESSION vs baseline captured ${b.capturedAt}:`);
      regressions.forEach((r) => console.error(r));
      console.error("\nIf this is intentional, re-run with --snapshot and commit the baseline.");
      process.exit(1);
    }
    console.log(`\nno regression vs baseline (${b.capturedAt}). Coverage ${b.coreCodeCoveragePct}% -> ${summary.coreCodeCoveragePct}%.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("coverage check failed:", e); process.exit(2); });
