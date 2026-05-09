/**
 * Gold-standard eval runner — pre-deploy gate.
 *
 * Usage:
 *   tsx scripts/gold-standard-eval.ts --threshold 0.95
 *
 * Source: pallio_complete_vision_v3 §15.2.
 *
 *   "Gold-standard eval must hit 95%+ before flipping live model
 *    from haiku to sonnet."
 *
 * This is a thin wrapper around the parser-only canon in
 * lib/ai/__tests__/gold-standard.fixtures.ts. The full lookup eval
 * (live DB + retrieval) lives in the integration suite.
 *
 * Exit:
 *   0 — pass rate ≥ threshold
 *   1 — below threshold
 *   2 — runner crashed (env / API)
 */
import { parseRuleQuery } from "@/lib/ai/anthropic.client";
import { GOLD_STANDARD } from "@/lib/ai/__tests__/gold-standard.fixtures";

interface Args {
  threshold: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let threshold = 0.95;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--threshold" && argv[i + 1]) {
      threshold = Number(argv[++i]);
    }
  }
  if (Number.isNaN(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error("--threshold must be in (0, 1]");
  }
  return { threshold };
}

async function main(): Promise<void> {
  const { threshold } = parseArgs();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("FATAL: ANTHROPIC_API_KEY not set.");
    process.exit(2);
  }
  if (GOLD_STANDARD.length < 49) {
    console.error(`FATAL: gold-standard canon has ${GOLD_STANDARD.length} entries, want ≥49`);
    process.exit(2);
  }

  console.log(
    `Running gold-standard eval over ${GOLD_STANDARD.length} questions, threshold ${(threshold * 100).toFixed(0)}%...`,
  );

  const failures: { id: string; field: string; expected: unknown; actual: unknown }[] = [];
  let passed = 0;

  for (const q of GOLD_STANDARD) {
    let qPassed = true;
    const parsed = await parseRuleQuery(q.query);
    for (const k of ["payer", "state", "cptCode", "attribute"] as const) {
      const expected = q.expectedParse[k];
      if (expected === undefined) continue;
      const actual = parsed[k];
      const ok = expected === null
        ? actual === null
        : (actual ?? "").toString().toLowerCase().includes(
            expected.toString().toLowerCase(),
          );
      if (!ok) {
        failures.push({ id: q.id, field: k, expected, actual });
        qPassed = false;
      }
    }
    if (qPassed) passed++;
  }

  const rate = passed / GOLD_STANDARD.length;
  console.log(`\nResults: ${passed}/${GOLD_STANDARD.length} = ${(rate * 100).toFixed(1)}%`);

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(
        `  ${f.id}.${f.field}: expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.actual)}`,
      );
    }
  }

  if (rate < threshold) {
    console.error(
      `\nFAIL — pass rate ${(rate * 100).toFixed(1)}% below threshold ${(threshold * 100).toFixed(0)}%.`,
    );
    process.exit(1);
  }
  console.log("\nPASS — gold-standard threshold met.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Eval runner crashed:", err);
  process.exit(2);
});
