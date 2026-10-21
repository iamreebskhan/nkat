/**
 * @vitest-environment jsdom
 */
/**
 * The denial page's "Partially paid" button, driven as a biller drives it.
 *
 * It used to post partially_paid with no amount at all; it now asks for the
 * figure, echoes it back, and posts it in cents. Requiring the figure opened a
 * dead end nothing covered: OK on an empty box returned exactly as Cancel does,
 * so the dialog closed, nothing was recorded, and nothing said so — a biller
 * could not tell that from an outcome recorded. No spec rendered this page.
 *
 * Plain createElement rather than JSX: lib specs are .ts (vitest.config.ts).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, Suspense, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

import DenialDetailPage from "@/app/(platform)/billing/denials/[id]/page";

const ID = "d0000000-0000-4000-8000-000000000001";

/** A refile decided and sent, its outcome still open: the buttons show. */
const DENIAL = {
  id: ID,
  superbillId: "b2e303af-e2cb-4292-8d00-c35c07423a0d",
  payerId: null,
  cptCode: "99344",
  icd10Codes: [],
  modifiers: [],
  carcCode: "16",
  rarcCode: null,
  groupCode: "CO",
  denialReason: null,
  deniedAmountCents: 11401,
  deniedAt: "2026-09-14T00:00:00.000Z",
  aiAnalysisText: null,
  aiLikelyCause: null,
  aiRecommendation: null,
  aiCitationDocName: null,
  aiCitationQuote: null,
  aiAnalyzedAt: null,
  aiModelVersion: null,
  decision: "refile",
  decisionAt: "2026-09-15T00:00:00.000Z",
  decisionByUserId: null,
  decisionNotes: null,
  refiledAt: "2026-09-15T00:00:00.000Z",
  outcome: "pending",
  outcomeAt: null,
  outcomeAmountCents: null,
  outcomeNotes: null,
  source: "recorded",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

/** The bodies POSTed to the outcome route. */
let recorded: Record<string, unknown>[];

beforeEach(() => {
  recorded = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = { success: false, error: "Not stubbed." };
      if (url === `/api/denials/${ID}`) body = { success: true, data: DENIAL };
      if (url === `/api/denials/${ID}/outcome` && init?.method === "POST") {
        recorded.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        body = { success: true, data: { ok: true } };
      }
      return Promise.resolve({ json: () => Promise.resolve(body) } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The page, loaded, with the prompt answering `typed` and confirm `confirmed`. */
async function pressPartiallyPaid(typed: string | null, confirmed = true) {
  const prompt = vi.spyOn(window, "prompt").mockReturnValue(typed);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(confirmed);
  // The page unwraps its params with use(), so it suspends first; an async
  // act lets that settle before the page is looked at.
  await act(async () => {
    render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(DenialDetailPage, { params: Promise.resolve({ id: ID }) }),
      ),
    );
  });
  fireEvent.click(await screen.findByRole("button", { name: "Partially paid" }));
  expect(prompt).toHaveBeenCalledTimes(1);
  return { confirm };
}

/** Lets any fetch the click started settle before asserting on silence. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("denial page — Partially paid", () => {
  it("says nothing was recorded when OK is pressed on an empty amount, and posts nothing", async () => {
    const { confirm } = await pressPartiallyPaid("   ");
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Nothing was recorded. Enter the amount the payer paid, from the EOB or remittance, in dollars and cents — for example 50.00.",
    );
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it("CONTROL — Cancel records nothing and says nothing", async () => {
    const { confirm } = await pressPartiallyPaid(null);
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it("CONTROL — an amount is echoed back, then posted as a partial recovery in cents", async () => {
    const { confirm } = await pressPartiallyPaid("50.00");
    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(confirm).toHaveBeenCalledWith(
      "Record a partial recovery of $50.00 on this denial (denied $114.01)?",
    );
    // No overpayment flag on a figure inside what was denied.
    expect(recorded[0]).toEqual({ outcome: "partially_paid", outcomeAmountCents: 5000 });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names both figures before a cents/dollars slip, and sends the confirmation with it as paid", async () => {
    // 5000 typed for $50.00. The server refuses an amount above the denial
    // unless the request says the biller confirmed it, and refuses it as a
    // partial recovery at all; so the flag and the outcome travel together.
    const { confirm } = await pressPartiallyPaid("5000");
    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(String(confirm.mock.calls[0]![0])).toContain(
      "$5000.00 is more than the $114.01 this denial was for.",
    );
    expect(recorded[0]).toEqual({
      outcome: "paid", outcomeAmountCents: 500000, overpaymentAcknowledged: true,
    });
  });

  it("CONTROL — declining the echo records nothing", async () => {
    await pressPartiallyPaid("5000", false);
    await settle();
    expect(recorded).toEqual([]);
  });
});
