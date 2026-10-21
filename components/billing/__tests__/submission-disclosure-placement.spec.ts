/**
 * Where the "Pallio does not send claims" line sits, and where it must not
 * (audit R35).
 *
 * submission-disclosure.spec.tsx next to this one proves the component renders
 * the right words. It cannot prove the words reach a reader, and that was the
 * whole failure: the component's own doc comment said it sat "under each
 * billing header" while three screens that print a claim status or a dollar
 * figure had never imported it, including the per-claim bill page the
 * superbill queue's own "Open →" link lands on.
 *
 * So this reads the page files. Parsing source in a test is ugly; a test that
 * cannot see the surface it guards is worse — the same trade attribute-map.spec
 * makes for the lookup route's zod enum.
 *
 * The absences are asserted as hard as the presences. On /billing/remittances
 * every figure is parsed from a payer's own 835, so "statuses and paid amounts
 * are what your team recorded" would be false there, and adding it out of
 * tidiness would be a regression, not an improvement.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP = join(process.cwd(), "app");
const COMPONENT = join(process.cwd(), "components/billing/submission-disclosure.tsx");

/** Every page.tsx under app/, as the route a person would type. */
function routes(dir: string, acc: Map<string, string> = new Map()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      routes(full, acc);
    } else if (entry.name === "page.tsx") {
      // app/(platform)/billing/denials/[id]/page.tsx → /billing/denials/[id]
      const route =
        full
          .slice(APP.length)
          .replace(/\\/g, "/")
          .replace(/\/page\.tsx$/, "")
          .replace(/\/\([^/]+\)/g, "") || "/";
      acc.set(route, full);
    }
  }
  return acc;
}

const ROUTES = routes(APP);
const rendersDisclosure = (route: string) => {
  const file = ROUTES.get(route);
  expect(file, `no page.tsx for ${route}`).toBeTruthy();
  return /<SubmissionDisclosure[\s/>]/.test(readFileSync(file!, "utf8"));
};

/** Screens that print a claim status or money Pallio did not get from a payer. */
const MUST_CARRY = [
  "/billing",
  "/billing/claims",
  "/billing/superbills",
  // The per-claim bill page: its header prints the status and the claim ref,
  // the card under it prints the billed amount, and "Mark ready to submit"
  // sends nothing to anyone.
  "/visits/[id]/superbill",
  // The denial page: "Mark as refiled" and "Record final outcome" write a
  // claim status and a dollar figure from outside Pallio.
  "/billing/denials/[id]",
];

/** Screens where the line would be false or meaningless, not merely repeated. */
const MUST_NOT_CARRY = [
  // The payer rule library. No claim, no status, no money.
  "/billing/lookup",
  // The form for typing in what an EOB said; its own field copy says so.
  "/billing/denials/log",
  // Figures parsed from a payer's own 835 — "what your team recorded" would
  // be false of every number on the screen.
  "/billing/remittances",
];

describe("SubmissionDisclosure placement (audit R35)", () => {
  it.each(MUST_CARRY)("%s carries the disclosure", (route) => {
    expect(rendersDisclosure(route)).toBe(true);
  });

  it.each(MUST_NOT_CARRY)("%s does not, and must not", (route) => {
    expect(rendersDisclosure(route)).toBe(false);
  });

  /**
   * The doc comment is the only index of where this component is used, and a
   * roster that drifts is how it came to claim "under each billing header"
   * while sitting under three of eight. Hold the comment to the imports.
   */
  it("the component's doc comment lists exactly the screens it sits on", () => {
    const src = readFileSync(COMPONENT, "utf8");
    const sits = src.slice(src.indexOf("WHERE IT SITS"), src.indexOf("WHERE IT DOES NOT"));
    expect(sits, "doc comment has no WHERE IT SITS section").not.toBe("");
    const claimed = [...sits.matchAll(/\/[A-Za-z0-9[\]/_-]+/g)].map((m) => m[0]);
    const actual = [...ROUTES.keys()].filter(rendersDisclosure);
    expect(claimed.sort()).toEqual(actual.sort());
  });
});
