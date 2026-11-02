/**
 * @vitest-environment jsdom
 */
/**
 * The reason for going ahead over a claim warning (0118). The status routes
 * take ten characters or more; a shorter one used to come back as the
 * request's own wording. It is asked for again here, saying why.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { askReason } from "../ask-reason";

afterEach(() => vi.restoreAllMocks());

const answering = (...answers: (string | null)[]) => {
  const prompt = vi.spyOn(window, "prompt");
  for (const a of answers) prompt.mockReturnValueOnce(a);
  return prompt;
};

describe("askReason", () => {
  it("returns a long enough reason, trimmed, asked once", () => {
    const prompt = answering("  Plan confirmed coverage by phone  ");
    expect(askReason("Warnings…")).toBe("Plan confirmed coverage by phone");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]![0]).toBe("Warnings…");
  });

  it("asks again over a short reason, saying why, and takes the next", () => {
    const prompt = answering("too short", "Plan confirmed coverage by phone");
    expect(askReason("Warnings…")).toBe("Plan confirmed coverage by phone");
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1]![0]).toBe(
      'The reason needs at least 10 characters — "too short" is 9.\n\nWarnings…',
    );
  });

  it("CONTROL: cancelling, or leaving it empty, goes no further", () => {
    answering(null);
    expect(askReason("Warnings…")).toBeNull();
    answering("   ");
    expect(askReason("Warnings…")).toBeNull();
    // Cancelling after a short reason too: nothing is sent.
    answering("short", null);
    expect(askReason("Warnings…")).toBeNull();
  });

  it("counts the trimmed reason: ten spaced-out characters are not ten", () => {
    const prompt = answering("   nine 9!   ", "ten chars!");
    expect(askReason("Warnings…")).toBe("ten chars!");
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});
