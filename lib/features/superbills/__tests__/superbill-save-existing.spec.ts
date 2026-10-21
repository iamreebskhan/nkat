/**
 * @vitest-environment jsdom
 */
/**
 * "Save superbill" on a page opened before the visit had a bill, when one has
 * been saved since — at sign-off, by someone else, in another tab.
 *
 * The save used to rebuild the bill from the visit over that one, then send
 * this page's edits on top, and the header read "draft" over a bill the
 * database held as "ready to submit" (localhost, 21 Oct). The page now shows
 * the bill as it stands, says so, and sends none of its own edits.
 *
 * The shipped page is rendered with its heavy children stubbed, against
 * stubbed routes.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, Suspense, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children),
}));
vi.mock("@/components/billing/code-picker", () => ({ CodePicker: () => null }));
vi.mock("@/components/billing/code-units-editor", () => ({ CodeUnitsEditor: () => null }));
vi.mock("@/components/billing/icd10-picker", () => ({ Icd10Picker: () => null }));
vi.mock("@/components/billing/rule-sidebar", () => ({ RuleSidebar: () => null }));
vi.mock("@/components/billing/time-spent-panel", () => ({ TimeSpentPanel: () => null }));

import SuperbillPage from "@/app/(platform)/visits/[id]/superbill/page";

const VISIT = "d855b6b1-e2c2-49c7-9ecc-17bbdc29a12f";
const BILL = "4aa35448-1786-46fb-8fe9-434bb29af746";
const PATIENT = "100d40c3-2ce2-4d86-8b55-58e9f42f55fa";

const BASE = {
  visitId: VISIT, patientId: PATIENT, payerId: null, memberIdSnapshot: "M-1",
  dateOfService: "2026-10-20", cptCodes: ["99497"], cptUnits: {}, icd10Codes: ["C34.90"],
  providerNpi: "1234567893", providerName: "Helen Okafor", billingNpi: "1234567893",
  placeOfServiceCode: "12", billedAmountCents: 7660,
};
/** What the visit drafts: no modifier. */
const DRAFT = { ...BASE, modifiers: [], ratedCodes: [], unratedCodes: [], warnings: [] };
/** The bill saved meanwhile: reviewed, with the biller's modifier 33. */
const SAVED = { ...BASE, id: BILL, status: "ready_to_submit", modifiers: ["33"], pricing: { lines: [] } };

let postAnswer: unknown;
let posts: number;
let patches: { patch: Record<string, unknown> }[];

beforeEach(() => {
  posts = 0;
  patches = [];
  postAnswer = { success: true, data: { id: BILL, created: false, existing: SAVED, draft: null } };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = { success: true, data: {} };
      if (url === `/api/visits/${VISIT}/superbill` && init?.method === "POST") {
        posts++;
        body = postAnswer;
      } else if (url === `/api/visits/${VISIT}/superbill`) {
        body = { success: true, data: { existing: null, draft: DRAFT } };
      } else if (url === `/api/superbills/${BILL}` && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        body = { success: true, data: { updated: true } };
      } else if (url === `/api/visits/${VISIT}`) {
        body = {
          success: true,
          data: { id: VISIT, codingBasis: "advance_care_planning", acpMinutes: 30, totalMinutes: 30, serviceDay: "2026-10-20" },
        };
      } else if (url === "/api/billing/code-bands") body = { success: true, data: { newPatientHome: [], establishedPatientHome: [] } };
      else if (url === `/api/patients/${PATIENT}`) body = { success: true, data: { id: PATIENT, state: "OH", insuranceState: "OH" } };
      else if (url === `/api/superbills/${BILL}/activity`) body = { success: true, data: { rows: [] } };
      else if (url === "/api/superbills/predict") body = { success: false, data: null, error: "stub" };
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(body) } as Response);
    }),
  );
  vi.spyOn(window, "alert").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openUnsavedBill() {
  await act(async () => {
    render(
      createElement(Suspense, { fallback: null }, createElement(SuperbillPage, { params: Promise.resolve({ id: VISIT }) })),
    );
  });
  await screen.findByText(/draft \(in-memory\)/);
}

const modifiersField = () => screen.getByLabelText("Modifiers (comma-separated)") as HTMLInputElement;

function typeModifier(value: string) {
  fireEvent.change(modifiersField(), { target: { value } });
  fireEvent.blur(modifiersField());
}

const NOTICE = "This visit already had a bill";

describe("Save superbill when the visit was billed since the page opened", () => {
  it("shows that bill as it stands, says so, and sends none of this page's edits", async () => {
    await openUnsavedBill();
    typeModifier("25");
    fireEvent.click(screen.getByRole("button", { name: "Save superbill" }));
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(screen.getByText(/Your changes to the modifiers were not applied/)).toBeTruthy();
    expect(posts).toBe(1);
    expect(patches).toEqual([]);
    // The bill's own status and modifier, not the draft's: the header's status.
    expect(screen.getByText(/^·\s*ready to submit$/)).toBeTruthy();
    expect(screen.queryByText(/draft \(in-memory\)/)).toBeNull();
    expect(modifiersField().value).toBe("33");
  });

  it("names no changes when there were none", async () => {
    await openUnsavedBill();
    fireEvent.click(screen.getByRole("button", { name: "Save superbill" }));
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(screen.queryByText(/Your changes/)).toBeNull();
    expect(patches).toEqual([]);
  });

  it("CONTROL: a first save still creates the bill, then saves this page's edits on it", async () => {
    postAnswer = { success: true, data: { id: BILL, created: true, draft: DRAFT } };
    await openUnsavedBill();
    typeModifier("25");
    fireEvent.click(screen.getByRole("button", { name: "Save superbill" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.patch).toEqual({ modifiers: ["25"] });
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(modifiersField().value).toBe("25");
  });
});
