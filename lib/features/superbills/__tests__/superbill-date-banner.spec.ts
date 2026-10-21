/**
 * @vitest-environment jsdom
 */
/**
 * The bill page says when a bill still being worked is dated a day other than
 * the one its visit started on where the practice is, and corrects it on
 * request (0107).
 *
 * A bill drafted before 0107 kept the visit start's UTC day — the next day for
 * an evening visit — with nothing on screen to say so; Shirley Tanaka's draft
 * read DOS 2026-09-23 for a visit on the 22nd. The shipped page is rendered
 * with its heavy children stubbed, against stubbed routes.
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

const VISIT = "d0000000-0000-4000-8000-000000000347";
const BILL = "76b7cf7f-966a-4cc0-8837-1fb07eac436f";
const PATIENT = "d0000000-0000-4000-8000-000000000213";

let bill: { status: string; dateOfService: string };
let serviceDay: string | null;
let corrections: number;
let activityReads: number;

const BANDS = {
  newPatientHome: [{ minMinutes: 15, maxMinutes: null, code: "99341" }],
  establishedPatientHome: [{ minMinutes: 20, maxMinutes: null, code: "99347" }],
};

beforeEach(() => {
  bill = { status: "draft", dateOfService: "2026-09-23" };
  serviceDay = "2026-09-22";
  corrections = 0;
  activityReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = { success: true, data: {} };
      if (url === `/api/visits/${VISIT}/superbill` && !init?.method) {
        body = {
          success: true,
          data: {
            existing: {
              id: BILL, visitId: VISIT, patientId: PATIENT, payerId: null, memberIdSnapshot: "M-1",
              dateOfService: bill.dateOfService, cptCodes: ["99349"], cptUnits: {}, icd10Codes: ["J84.10"],
              modifiers: [], providerNpi: "1234567893", providerName: "Marcus Delgado", billingNpi: "1234567893",
              placeOfServiceCode: "12", billedAmountCents: 7013, status: bill.status, pricing: { lines: [] },
            },
            draft: null,
          },
        };
      } else if (url === `/api/visits/${VISIT}`) {
        body = {
          success: true,
          data: { id: VISIT, codingBasis: "established_patient_home", acpMinutes: 0, totalMinutes: 40, serviceDay },
        };
      } else if (url === "/api/billing/code-bands") body = { success: true, data: BANDS };
      else if (url === `/api/patients/${PATIENT}`) body = { success: true, data: { id: PATIENT, state: "OH", insuranceState: "OH" } };
      else if (url === `/api/superbills/${BILL}/activity`) {
        activityReads++;
        body = { success: true, data: { rows: [] } };
      } else if (url === `/api/superbills/${BILL}/correct-date` && init?.method === "POST") {
        corrections++;
        body = { success: true, data: { from: "2026-09-23", to: "2026-09-22", billedAmountCents: 7013, status: "draft" } };
      } else if (url === "/api/superbills/predict") body = { success: false, data: null, error: "stub" };
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

async function openBill() {
  await act(async () => {
    render(
      createElement(Suspense, { fallback: null }, createElement(SuperbillPage, { params: Promise.resolve({ id: VISIT }) })),
    );
  });
  await screen.findByRole("heading", { level: 1, name: "Superbill" });
}

const BANNER = /This bill is dated 2026-09-23, but the visit started on 2026-09-22/;

describe("the bill page — a date of service that is not the visit's day", () => {
  it("says so, and corrects it on request: the header then shows the visit's day", async () => {
    await openBill();
    expect(await screen.findByText(BANNER)).toBeTruthy();
    const before = activityReads;
    fireEvent.click(screen.getByRole("button", { name: "Correct the date to 2026-09-22" }));
    await waitFor(() => expect(corrections).toBe(1));
    await waitFor(() => expect(screen.getByText(/DOS 2026-09-22/)).toBeTruthy());
    expect(screen.queryByText(BANNER)).toBeNull();
    // The bill's history is read again, so the correction shows there.
    await waitFor(() => expect(activityReads).toBeGreaterThan(before));
  });

  it("CONTROL: says nothing when the bill already carries the visit's day", async () => {
    bill.dateOfService = "2026-09-22";
    await openBill();
    await waitFor(() => expect(screen.getByText(/DOS 2026-09-22/)).toBeTruthy());
    // Give the visit read time to land before asserting the absence.
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => u === `/api/visits/${VISIT}`)).toBe(true));
    expect(screen.queryByRole("button", { name: /Correct the date/ })).toBeNull();
  });

  it("CONTROL: never offers it on a claim already sent, whose date the payer holds", async () => {
    bill.status = "submitted";
    await openBill();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => u === `/api/visits/${VISIT}`)).toBe(true));
    expect(screen.getByText(/DOS 2026-09-23/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Correct the date/ })).toBeNull();
  });
});
