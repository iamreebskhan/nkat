/**
 * @vitest-environment jsdom
 */
/**
 * The panel beside the note saves itself.
 *
 * Times, diagnoses, place of service, ACP minutes and the telehealth fields
 * were saved only by Save draft or Sign, while every note section saved itself
 * on blur. Found on production on 2026-10-22: a diagnosis picked and left on
 * screen was not saved, and leaving the page said nothing. The panel now saves
 * itself shortly after a change, says a change is not yet saved, and leaving
 * with one pending asks first. Opening a visit saves nothing.
 *
 * The shipped page is rendered with its heavy children stubbed, as in
 * document-acp-base-code.spec.ts, and driven through the ACP minutes input.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, Suspense, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("@/components/billing/rule-sidebar", () => ({ RuleSidebar: () => null }));
vi.mock("@/components/editor/tiptap-editor", () => ({ TipTapEditor: () => null }));
vi.mock("@/components/visits/diagnosis-picker", () => ({ DiagnosisPicker: () => null }));
vi.mock("@/components/visits/note-preview", () => ({ NotePreview: () => null }));
vi.mock("@/components/visits/visit-addenda", () => ({ VisitAddenda: () => null }));
vi.mock("@/components/visits/visit-services-panel", () => ({ VisitServicesPanel: () => null }));
vi.mock("@/components/visits/sectioned-note", () => ({
  SectionedNote: (props: { registerFlush?: (fn: () => Promise<boolean>) => void }) => {
    props.registerFlush?.(async () => true);
    return null;
  },
}));

import VisitDocumentPage from "@/app/(platform)/visits/[id]/document/page";

const ID = "e0000000-0000-4000-8000-00000000000c";
const PID = "f0000000-0000-4000-8000-000000000003";

const BANDS = {
  newPatientHome: [
    { minMinutes: 15, maxMinutes: 29, code: "99341" },
    { minMinutes: 30, maxMinutes: 59, code: "99342" },
    { minMinutes: 60, maxMinutes: 74, code: "99344" },
    { minMinutes: 75, maxMinutes: null, code: "99345" },
  ],
  establishedPatientHome: [
    { minMinutes: 20, maxMinutes: 29, code: "99347" },
    { minMinutes: 30, maxMinutes: 39, code: "99348" },
    { minMinutes: 40, maxMinutes: 59, code: "99349" },
    { minMinutes: 60, maxMinutes: null, code: "99350" },
  ],
};

const VISIT = {
  id: ID, patientId: PID, clinicianUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  visitType: "established_patient_home", visitTypeLabel: "Established patient — home",
  codingBasis: "established_patient_home", visitTypeIsTelehealth: false,
  scheduledStart: "2026-09-25T14:00:00.000Z", scheduledEnd: null,
  startTime: "2026-09-25T14:00:00.000Z", stopTime: "2026-09-25T14:50:00.000Z", totalMinutes: 50,
  acpMinutes: 0, prolongedMinutes: 0, isTelehealth: false, telehealthModality: null,
  telehealthConsentDocumented: false, placeOfServiceCode: "12",
  signedByUserId: null, signerName: null, signerCredential: null, documentText: null,
  cptCodesAssigned: [], cptUnits: {}, icd10Codes: ["C34.90"], modifiers: [],
  status: "in_progress", signedAt: null,
  createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
};

let patches: Record<string, unknown>[];
let patientServed: boolean;

beforeEach(() => {
  patches = [];
  patientServed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = { success: false, data: null, error: "Not stubbed." };
      if (url === `/api/visits/${ID}` && !init?.method) body = { success: true, data: VISIT };
      else if (url === "/api/billing/code-bands") body = { success: true, data: BANDS };
      else if (url === "/api/auth/me") {
        body = { success: true, data: { permissions: ["visits.view.own", "visits.edit", "visits.submit"], role: "clinician" } };
      } else if (url === `/api/visits/${ID}/reconciliation`) body = { success: true, data: { findings: [] } };
      else if (url === `/api/patients/${PID}`) {
        patientServed = true;
        body = {
          success: true,
          data: { id: PID, firstName: "Test", lastName: "Autosave", dateOfBirth: "1940-01-01", primaryPayerType: "medicare_mac", telehealthConsentAt: null },
        };
      } else if (url === `/api/visits/${ID}/document` && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        body = { success: true, data: { updated: true } };
      }
      return Promise.resolve({ status: 200, json: () => Promise.resolve(body) } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openPage() {
  await act(async () => {
    render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(VisitDocumentPage, { params: Promise.resolve({ id: ID }) }),
      ),
    );
  });
  await screen.findByRole("heading", { level: 1 });
  await waitFor(() => expect(patientServed).toBe(true));
}

/** A beforeunload as the browser fires it; true when the page asked to stay. */
function leaving(): boolean {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("the visit's side panel saves itself", () => {
  it("CONTROL: opening a visit saves nothing and asks nothing on leaving", async () => {
    await openPage();
    await new Promise((r) => setTimeout(r, 2000));
    expect(patches).toHaveLength(0);
    expect(leaving()).toBe(false);
  });

  it("saves a change shortly after it, and asks before leaving until it has", async () => {
    await openPage();
    fireEvent.change(screen.getByLabelText(/ACP minutes/), { target: { value: "20" } });
    expect(await screen.findByText(/Unsaved changes/)).toBeTruthy();
    expect(leaving()).toBe(true);
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 4000 });
    expect(patches[0]).toMatchObject({ acpMinutes: 20, icd10Codes: ["C34.90"] });
    await waitFor(() => expect(screen.queryByText(/Unsaved changes/)).toBeNull());
    expect(leaving()).toBe(false);
  });

  it("Save draft clears the pending change at once, and the timer then has nothing to save", async () => {
    await openPage();
    fireEvent.change(screen.getByLabelText(/ACP minutes/), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    await waitFor(() => expect(leaving()).toBe(false));
    await new Promise((r) => setTimeout(r, 2000));
    expect(patches).toHaveLength(1);
  });
});
