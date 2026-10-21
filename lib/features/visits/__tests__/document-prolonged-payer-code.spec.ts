/**
 * @vitest-environment jsdom
 */
/**
 * The Suggested codes card on /visits/[id]/document offers the prolonged-service
 * add-on the patient's payer takes (0108).
 *
 * The page chose by payer type alone: Medicare and Medicare Advantage got
 * G0318, every other payer 99417. A payer record may now name its own code, as
 * an Ohio Medicaid managed-care plan that takes G0318 does, and the card offers
 * that code with that code's timing. A record that names none leaves the type
 * to decide, exactly as before.
 *
 * The shipped page is rendered with its heavy children stubbed, and driven the
 * way a clinician drives it: open a 120-minute visit, read the card, Save draft.
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

const ID = "e0000000-0000-4000-8000-0000000000c1";
const PID = "f0000000-0000-4000-8000-000000000002";

/** /api/billing/code-bands as it arrives over the wire: Infinity is null in JSON. */
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

const TYPES = [
  { slug: "new_patient_home", label: "New patient — home", codingBasis: "new_patient_home", isTelehealth: false },
  { slug: "established_patient_home", label: "Established patient — home", codingBasis: "established_patient_home", isTelehealth: false },
];

/** An open established visit, 120 minutes start to stop. */
const BASE_VISIT = {
  id: ID, patientId: PID, clinicianUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  visitType: "established_patient_home", visitTypeLabel: "Established patient — home",
  codingBasis: "established_patient_home", visitTypeIsTelehealth: false,
  scheduledStart: "2026-09-25T14:00:00.000Z", scheduledEnd: null,
  startTime: "2026-09-25T14:00:00.000Z", stopTime: "2026-09-25T16:00:00.000Z", totalMinutes: 120,
  acpMinutes: 0, prolongedMinutes: 0, isTelehealth: false, telehealthModality: null as string | null,
  telehealthConsentDocumented: false, placeOfServiceCode: "12",
  signedByUserId: null, signerName: null, signerCredential: null, documentText: null,
  cptCodesAssigned: [] as string[], cptUnits: {}, icd10Codes: ["C34.90"], modifiers: [],
  status: "in_progress", signedAt: null as string | null,
  createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
};

type Visit = typeof BASE_VISIT & Record<string, unknown>;
let current: Visit;
/** The patient's payer as GET /api/patients/[id] serves it. */
let payer: { primaryPayerType: string | null; primaryPayerProlongedCode: string | null };
let documentPatches: Record<string, unknown>[];
/** Set once GET /api/patients/[id] has answered, so the payer is on screen. */
let patientServed: boolean;

beforeEach(() => {
  current = { ...BASE_VISIT };
  payer = { primaryPayerType: "medicaid_mco", primaryPayerProlongedCode: null };
  documentPatches = [];
  patientServed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = { success: false, data: null, error: "Not stubbed." };
      if (url === `/api/visits/${ID}` && !init?.method) body = { success: true, data: current };
      else if (url === "/api/billing/code-bands") body = { success: true, data: BANDS };
      else if (url === "/api/auth/me") {
        body = { success: true, data: { permissions: ["visits.view.own", "visits.edit", "visits.submit", "patients.view"], role: "clinician" } };
      } else if (url === `/api/visits/${ID}/reconciliation`) body = { success: true, data: { findings: [] } };
      else if (url === `/api/patients/${PID}`) {
        patientServed = true;
        body = {
          success: true,
          data: { id: PID, firstName: "Test", lastName: "Prolonged", dateOfBirth: "1940-01-01", ...payer, telehealthConsentAt: null },
        };
      } else if (url === "/api/settings/visit-types") body = { success: true, data: { types: TYPES } };
      else if (url.startsWith(`/api/patients/${PID}/visit-type-hint?`)) {
        body = {
          success: true,
          data: { lastVisitAt: "2026-03-10T15:00:00.000Z", lastVisitStatus: "documented", windowStart: "2023-09-25T14:00:00.000Z", suggestedBasis: "established_patient_home" },
        };
      } else if (url === `/api/visits/${ID}/document` && init?.method === "PATCH") {
        documentPatches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
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

async function saveDraft() {
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(documentPatches).toHaveLength(1));
  return documentPatches[0]!;
}

describe("Suggested codes — the prolonged-service code the payer takes (0108)", () => {
  it("a Medicaid plan whose record names G0318 is offered G0318, counted from the CMS total time", async () => {
    payer = { primaryPayerType: "medicaid_mco", primaryPayerProlongedCode: "G0318" };
    await openPage();
    expect(await screen.findByText("G0318")).toBeTruthy();
    expect(screen.queryByText("99417")).toBeNull();
    // 120 minutes on 99350: 25 past the 95-minute CMS total, one full 15.
    expect(screen.getByText(/25 minutes past the 95-minute CMS total for 99350/)).toBeTruthy();
    expect(screen.getByText(/The prolonged home-visit add-on this payer takes/)).toBeTruthy();
    const sent = await saveDraft();
    expect(sent).toMatchObject({ cptCodesAssigned: ["99350", "G0318"], cptUnits: {}, totalMinutes: 120 });
  });

  it("CONTROL: the same plan with no code on its record is offered 99417, as before", async () => {
    await openPage();
    expect(await screen.findByText("99417")).toBeTruthy();
    expect(screen.queryByText("G0318")).toBeNull();
    expect(screen.getByText(/Non-Medicare prolonged-service add-on/)).toBeTruthy();
    const sent = await saveDraft();
    expect(sent).toMatchObject({ cptCodesAssigned: ["99350", "99417"], cptUnits: { "99417": 4 }, totalMinutes: 120 });
  });

  it("CONTROL: Medicare with no code on its record is still offered G0318 as Medicare", async () => {
    payer = { primaryPayerType: "medicare_mac", primaryPayerProlongedCode: null };
    await openPage();
    expect(await screen.findByText("G0318")).toBeTruthy();
    expect(screen.getByText(/Medicare prolonged home-visit add-on/)).toBeTruthy();
  });
});
