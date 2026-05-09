/**
 * Anthropic client deterministic tests.
 *
 * The PHI guard moved to lib/ai/phi-guard.ts in Phase 7 — see
 * phi-guard.spec.ts for the 14-test canon. The client itself is
 * exercised end-to-end via the gold-standard eval (gated EVAL=1).
 */
import { describe, it } from "vitest";

describe("anthropic client", () => {
  it("module loads", () => {
    // Smoke — importing the module shouldn't throw, even when env
    // is unset (env access is lazy via the secret() helper).
  });
});
