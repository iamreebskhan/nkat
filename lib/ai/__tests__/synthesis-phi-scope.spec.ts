/**
 * What the PHI guard reads as what in a rule synthesis. The question and the
 * structured rule are held to the prompt bar; the chunks are payer documents,
 * held to the document bar they passed at ingestion. Read as a prompt, one
 * "revised 01/01/2026" in a chunk refused the synthesis.
 *
 * The SDK is stubbed; the guard is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));
vi.mock("@/lib/env", () => ({ env: () => ({ ANTHROPIC_API_KEY: "test-key-not-real" }) }));
vi.mock("@/lib/features/admin/runtime-settings", () => ({ getSettingValue: vi.fn(async () => null), isClaudeModel: () => true }));

import { synthesizeRuleAnswer } from "../anthropic.client";
import { PhiGuardError } from "../phi-guard";

const DATED_CHUNK = 'Ohio Medicaid Non-Institutional Fee Schedule, revised 01/01/2026: "99348 | Home visit, established patient" is payable.';

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({ content: [{ type: "text", text: "NO_RULE_FOUND" }] });
});

describe("synthesizeRuleAnswer — the PHI guard", () => {
  it("lets a payer document's own dates through to the model", async () => {
    await synthesizeRuleAnswer({ query: "Is 99348 covered by CareSource Ohio?", structuredRule: null, chunks: [DATED_CHUNK] });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: a date in the question is refused before any call", async () => {
    await expect(
      synthesizeRuleAnswer({ query: "Patient born 03/14/1949, is 99348 covered?", structuredRule: null, chunks: [DATED_CHUNK] }),
    ).rejects.toBeInstanceOf(PhiGuardError);
    expect(create).not.toHaveBeenCalled();
  });

  it("CONTROL: a date in the structured rule is refused, as before", async () => {
    await expect(
      synthesizeRuleAnswer({ query: "Is 99348 covered?", structuredRule: "Rep confirmed on 01/01/2026", chunks: [] }),
    ).rejects.toBeInstanceOf(PhiGuardError);
    expect(create).not.toHaveBeenCalled();
  });

  it("CONTROL: an SSN in a chunk is refused at any density", async () => {
    await expect(
      synthesizeRuleAnswer({ query: "Is 99348 covered?", structuredRule: null, chunks: ["Member SSN 123-45-6789"] }),
    ).rejects.toBeInstanceOf(PhiGuardError);
    expect(create).not.toHaveBeenCalled();
  });
});
