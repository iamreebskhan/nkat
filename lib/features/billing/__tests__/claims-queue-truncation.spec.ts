/**
 * The claims queue's "there is more in the queue" banner, held to what the
 * API now tells it.
 *
 * /billing/claims fetches one page per status at limit=200 and decides whether
 * the queue is hiding work. The superbills half has always compared the
 * server's `total` for the filter with the rows it received. The visits half
 * could not: /api/visits returned rows only, so the page inferred truncation
 * from a full page — `(r.data?.rows ?? []).length >= 200`.
 *
 * That inference is wrong at exactly one point, and it is the point a busy
 * queue sits on: a status holding EXACTLY 200 visits returns all 200 of them,
 * nothing is left out, and the page raised an amber banner saying there is
 * more in the queue than the counts below and telling the agent to work
 * through these and reload. The KPI numbers beside it were complete and were
 * being called short.
 *
 * /api/visits now returns a real `total` (app/api/visits/route.ts), counted by
 * countVisits under listVisits' three predicates character for character —
 * patientId, status and clinicianUserId — inside the same withOrgContext, and
 * handed the same narrowed clinicianUserId the rows were read with, so a
 * clinician holding only visits.view.own is counted over their own visits and
 * not the org's. The comparison here is therefore like for like.
 *
 * app/ is outside vitest's include globs (see vitest.config.ts), so this reads
 * the page source. Reading source is a weak oracle on its own — a test that
 * greps for `total` passes against an expression that names it and still
 * compares against 200 — so the shipped expression is EXTRACTED and EVALUATED,
 * the pattern lib/features/visits/__tests__/document-page-truthfulness.spec.ts
 * uses, with its balanced() helper.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  join(process.cwd(), "app/(platform)/billing/claims/page.tsx"),
  "utf8",
);

/**
 * The whole parenthesised expression opening at `open`, counted rather than
 * matched. `[^)]*` stops at the first inner ")", which here is the one closing
 * `vRes.some(` — it would hand back half the check and this file would then
 * evaluate something the page does not contain.
 */
function balanced(src: string, open: number, where = "the claims queue page"): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced expression in ${where}`);
}

const callAt = SRC.indexOf("setTruncated(");
/** The argument to setTruncated, trailing comma and all. */
const argSrc =
  callAt < 0 ? "" : balanced(SRC, SRC.indexOf("(", callAt)).slice(1, -1).replace(/,\s*$/, "");

interface Res {
  success: boolean;
  data?: { rows?: unknown[]; total?: number };
}

/** The shipped decision, run for real. */
const isTruncated =
  argSrc === ""
    ? null
    : (new Function("vRes", "sRes", `return Boolean(${argSrc});`) as (
        vRes: Res[],
        sRes: Res[],
      ) => boolean);

/** One status' response: `n` rows delivered out of `total` that match. */
const page = (n: number, total: number): Res => ({
  success: true,
  data: { rows: Array.from({ length: n }, (_, i) => ({ id: `v${i}` })), total },
});

describe("the claims queue's truncation banner, for visits", () => {
  it("does not call a complete page of exactly 200 a truncated one", () => {
    expect(isTruncated, "could not find the setTruncated expression").toBeTruthy();
    // The defect: 200 visits in the status, 200 rows on screen, nothing
    // hidden — and the banner told the agent the counts below were short and
    // to reload for rows that do not exist.
    expect(isTruncated!([page(200, 200)], [])).toBe(false);
  });

  it("still raises it when the server holds one more than the page", () => {
    expect(isTruncated!([page(200, 201)], [])).toBe(true);
  });

  it("compares the total, not the page limit", () => {
    // The old form could only ever fire at the limit. Asserted by running the
    // expression, because requiring it to NAME `total` is satisfied by
    // `Number(r.data?.total ?? 0) >= 0 && rows.length >= 200`, which is the
    // same untruth wearing the honest field's name.
    expect(isTruncated!([page(5, 9)], [])).toBe(true);
    expect(isTruncated!([page(5, 5)], [])).toBe(false);
    expect(isTruncated!([page(0, 0)], [])).toBe(false);
  });

  it("raises it when any one of the statuses is short", () => {
    // READY_VISIT_STATUS is fetched one request per status; a complete
    // `documented` page must not mask a truncated `pending_billing` one.
    expect(isTruncated!([page(200, 200), page(200, 201)], [])).toBe(true);
    expect(isTruncated!([page(200, 201), page(200, 200)], [])).toBe(true);
  });

  it("does not speak for a request that failed", () => {
    // Unchanged: a failed status has no rows and no total worth trusting, and
    // the error banner above already says the queue did not load. Claiming
    // truncation on top of it would be a second, invented sentence.
    expect(isTruncated!([{ success: false, data: { rows: [], total: 999 } }], [])).toBe(false);
  });
});

describe("the superbills half of the same check", () => {
  it("is unchanged — total against rows received", () => {
    expect(isTruncated!([], [page(200, 200)])).toBe(false);
    expect(isTruncated!([], [page(200, 201)])).toBe(true);
    expect(isTruncated!([], [page(3, 5)])).toBe(true);
    expect(isTruncated!([], [{ success: false, data: { rows: [], total: 999 } }])).toBe(false);
  });

  it("is now the same expression the visits half uses", () => {
    // Pinned as a pair so the honest form cannot be reverted on one side
    // alone: whatever these two compare, they compare identically. The page is
    // CRLF, so whitespace is collapsed before comparing rather than anchored.
    const branch = (name: string): string => {
      const at = SRC.indexOf(`${name}.some`, callAt);
      expect(at, `could not find the ${name} branch`).toBeGreaterThan(-1);
      return balanced(SRC, SRC.indexOf("(", at)).replace(/\s+/g, " ");
    };
    expect(branch("vRes")).toBe(branch("sRes"));
  });

  it("no longer carries the page-limit literal at all", () => {
    // Its own test rather than a line after the pairing above, so that the
    // literal that was there when a full page was called truncated is proven
    // gone on its own and not merely shadowed by an earlier failure.
    expect(argSrc.replace(/\s+/g, " ")).not.toMatch(/length\s*>=\s*200/);
  });

  it("gates the banner whose copy promises hidden rows", () => {
    // What the assertions above are worth depends on this text staying the
    // claim being made: if the banner stopped saying there is more in the
    // queue, being right about truncation would no longer be the point.
    expect(SRC).toMatch(/there is more in the queue than the/);
  });
});
