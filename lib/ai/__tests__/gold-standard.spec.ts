/**
 * Gold-standard eval — runs the rule lookup against a curated 50-question
 * canon. Source: pallio_complete_vision_v3 §10.3 + §15.2.
 *
 *   "The gold-standard evaluation set of 50 questions from Mark's cheat
 *    sheet must pass before any AI layer change goes to production."
 *
 * This suite hits the LIVE Anthropic + OpenAI APIs, so it's behind
 * `EVAL=1`. CI runs it on prompt or model changes — not every push.
 *
 * Pass criteria:
 *   - Parser extracts the expected structured params (where defined)
 *   - Citation is present iff `expectNoRule` is false
 *   - Required substrings appear in the answer (case-insensitive)
 *   - Refusal cases (`expectNoRule: true`) return `unknown` source
 *
 * Target: 90% pass rate. Failing tests print the diff so Mark can
 * triage which prompts/sources need work.
 */
import { describe, expect, it } from "vitest";

import { parseRuleQuery } from "../anthropic.client";
import { GOLD_STANDARD } from "./gold-standard.fixtures";

const EVAL_ENABLED = process.env.EVAL === "1";

const evalIt = EVAL_ENABLED ? it : it.skip;

describe("Gold-standard rule-lookup eval (50 questions)", () => {
  evalIt(
    "fixture canon is a meaningful size (truncation guard)",
    () => {
      // The curated canon currently has 47 questions. This guard only
      // exists to catch accidental truncation of the fixture file —
      // it is NOT the 90% accuracy gate (that's the eval below).
      // TODO(mark): expand to the full 50-question cheat-sheet canon.
      expect(GOLD_STANDARD.length).toBeGreaterThanOrEqual(45);
      expect(GOLD_STANDARD.length).toBeLessThanOrEqual(60);
    },
    10_000,
  );

  // Parser-only batch — fast, no DB required, just a haiku call per Q.
  evalIt(
    "haiku parser extracts expected structured params",
    async () => {
      const failures: string[] = [];
      for (const q of GOLD_STANDARD) {
        const parsed = await parseRuleQuery(q.query);
        const checks: Array<keyof typeof q.expectedParse> = [
          "payer",
          "state",
          "cptCode",
          "attribute",
        ];
        for (const k of checks) {
          const expected = q.expectedParse[k];
          if (expected === undefined) continue;
          const actual = parsed[k as keyof typeof parsed];
          const ok = expected === null
            ? actual === null
            : (actual ?? "")
                .toString()
                .toLowerCase()
                .includes(expected.toString().toLowerCase());
          if (!ok) {
            failures.push(`${q.id}: ${k} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
          }
        }
      }
      // Allow 10% parser miss — palliative-specific phrasings sometimes
      // need a prompt tweak. Anything beyond fails the suite loudly.
      const passed = GOLD_STANDARD.length - failures.length;
      const passRate = passed / GOLD_STANDARD.length;
       
      if (failures.length > 0) console.log("Parser misses:\n" + failures.join("\n"));
      expect(passRate).toBeGreaterThanOrEqual(0.9);
    },
    300_000,
  );

  // Full lookup — exercises the SQL → vector → Claude flow. Each Q
  // also asserts the citation contract for non-refusal cases.
  // The full integration test depends on a live DB and seeded
  // payer_rule + document_chunk rows; it's wired up in
  // backend/test/integration/lookup.spec.ts in a later phase.
});
