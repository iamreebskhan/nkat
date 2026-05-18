/**
 * Anthropic client deterministic tests.
 *
 * The PHI guard moved to lib/ai/phi-guard.ts in Phase 7 — see
 * phi-guard.spec.ts. End-to-end model behaviour is the gold-standard
 * eval (gated EVAL=1). These tests lock the JSON-extraction logic,
 * which the eval caught failing when haiku appended prose after the
 * JSON ("Unexpected non-whitespace character after JSON").
 */
import { describe, expect, it } from "vitest";

import { extractJsonObject } from "../anthropic.client";

describe("extractJsonObject", () => {
  const obj = { payer: "Humana", state: "OH", cptCode: "99349", attribute: "covered" };

  it("parses bare JSON", () => {
    expect(extractJsonObject(JSON.stringify(obj))).toEqual(obj);
  });

  it("strips ```json fences", () => {
    expect(
      extractJsonObject("```json\n" + JSON.stringify(obj) + "\n```"),
    ).toEqual(obj);
  });

  it("ignores prose appended AFTER the JSON (the eval regression)", () => {
    const text = `${JSON.stringify(obj)}\n\nHere's how I parsed that query.`;
    expect(extractJsonObject(text)).toEqual(obj);
  });

  it("ignores prose BEFORE the JSON", () => {
    expect(
      extractJsonObject(`Sure! Here is the result:\n${JSON.stringify(obj)}`),
    ).toEqual(obj);
  });

  it("handles braces inside string values", () => {
    const tricky = { note: "covered when code in {99349,99350}", state: "OH" };
    expect(
      extractJsonObject("text " + JSON.stringify(tricky) + " trailing"),
    ).toEqual(tricky);
  });

  it("handles escaped quotes inside strings", () => {
    const q = { answer: 'rep said \\"no PA\\" required' };
    const raw = `\`\`\`json ${JSON.stringify(q)} \`\`\` done`;
    expect(extractJsonObject(raw)).toEqual(q);
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractJsonObject("I could not parse that.")).toThrow();
  });

  it("throws on an unterminated object", () => {
    expect(() => extractJsonObject('{"payer":"Humana"')).toThrow();
  });
});
