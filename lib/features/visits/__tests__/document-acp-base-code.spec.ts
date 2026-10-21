/**
 * @vitest-environment jsdom
 */
/**
 * The Suggested codes card on /visits/[id]/document chooses the base E/M code
 * on E/M time: the visit's start-to-stop total less the minutes that bill as
 * 99497/99498.
 *
 * The page passes the whole total and the ACP minutes to the suggester, and the
 * suggester took the ACP minutes out of the prolonged-service add-on only. The
 * base code was still chosen on the whole total, so a 50-minute visit with 20
 * minutes of ACP showed and saved 99349 + 99497, where its 30 E/M minutes are
 * 99348. Under 16 ACP minutes nothing bills as ACP, so nothing comes out.
 *
 * The shipped page is rendered with its heavy children stubbed, and driven the
 * way a clinician drives it: type the ACP minutes, read the card, Save draft.
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

const ID = "e0000000-0000-4000-8000-00000000000b";
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

/** An open established visit, 50 minutes start to stop, no ACP minutes yet. */
const BASE_VISIT = {
  id: ID, patientId: PID, clinicianUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  visitType: "established_patient_home", visitTypeLabel: "Established patient — home",
  codingBasis: "established_patient_home", visitTypeIsTelehealth: false,
  scheduledStart: "2026-09-25T14:00:00.000Z", scheduledEnd: null,
  startTime: "2026-09-25T14:00:00.000Z", stopTime: "2026-09-25T14:50:00.000Z", totalMinutes: 50,
  acpMinutes: 0, prolongedMinutes: 0, isTelehealth: false, telehealthModality: null as string | null,
  telehealthConsentDocumented: false, placeOfServiceCode: "12",
  signedByUserId: null, signerName: null, signerCredential: null, documentText: null,
  cptCodesAssigned: [] as string[], cptUnits: {}, icd10Codes: ["C34.90"], modifiers: [],
  status: "in_progress", signedAt: null as string | null,
  createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
};

type Visit = typeof BASE_VISIT & Record<string, unknown>;
let current: Visit;
let documentPatches: Record<string, unknown>[];
/** Set once GET /api/patients/[id] has answered, so the payer is Medicare on screen. */
let patientServed: boolean;

beforeEach(() => {
  current = { ...BASE_VISIT };
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
          data: { id: PID, firstName: "Test", lastName: "Acpbase", dateOfBirth: "1940-01-01", primaryPayerType: "medicare_mac", telehealthConsentAt: null },
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

const typeAcp = (minutes: number) =>
  fireEvent.change(screen.getByLabelText(/ACP minutes/), { target: { value: String(minutes) } });

async function saveDraft() {
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(documentPatches).toHaveLength(1));
  return documentPatches[0]!;
}

const BASE_NOTE = /No home-visit E\/M code on time/;

describe("Suggested codes — the base code is chosen on E/M time", () => {
  it("50 minutes with 20 of ACP show and save 99348 + 99497, not 99349", async () => {
    await openPage();
    expect(await screen.findByText("99349")).toBeTruthy();
    typeAcp(20);
    expect(await screen.findByText("99348")).toBeTruthy();
    expect(screen.getByText("99497")).toBeTruthy();
    expect(screen.queryByText("99349")).toBeNull();
    // The base row says which minutes it was chosen on.
    expect(screen.getByText(/Counted on 30 of the 50 minutes/)).toBeTruthy();
    expect(screen.queryByText(BASE_NOTE)).toBeNull();
    const sent = await saveDraft();
    expect(sent).toMatchObject({
      cptCodesAssigned: ["99348", "99497"],
      cptUnits: {},
      totalMinutes: 50,
      acpMinutes: 20,
    });
  });

  it("CONTROL: 10 ACP minutes bill nothing as ACP, so the base stays 99349 on the whole 50", async () => {
    await openPage();
    expect(await screen.findByText("99349")).toBeTruthy();
    typeAcp(10);
    await waitFor(() => expect((screen.getByLabelText(/ACP minutes/) as HTMLInputElement).value).toBe("10"));
    expect(screen.getByText("99349")).toBeTruthy();
    expect(screen.queryByText("99497")).toBeNull();
    expect(screen.queryByText(/Counted on/)).toBeNull();
    const sent = await saveDraft();
    expect(sent).toMatchObject({ cptCodesAssigned: ["99349"], acpMinutes: 10 });
  });

  it("a 30-minute visit that was all ACP codes 99497 alone, and the card says why there is no base code", async () => {
    current = { ...BASE_VISIT, stopTime: "2026-09-25T14:30:00.000Z", totalMinutes: 30 };
    await openPage();
    expect(await screen.findByText("99348")).toBeTruthy();
    typeAcp(30);
    expect(await screen.findByText(BASE_NOTE)).toBeTruthy();
    expect(screen.getByText(/0 of the 30 minutes are E\/M time, short of the 20 minutes 99347 needs/)).toBeTruthy();
    expect(screen.getByText("99497")).toBeTruthy();
    expect(screen.queryByText("99348")).toBeNull();
    // Not the inconclusive line: 99497 is a code, and the visit can be signed.
    expect(screen.queryByText(/No conclusive code yet/)).toBeNull();
    const sent = await saveDraft();
    expect(sent).toMatchObject({ cptCodesAssigned: ["99497"], cptUnits: {}, totalMinutes: 30, acpMinutes: 30 });
  });

  it("CONTROL: the same 30 minutes with no ACP are 99348, with no note", async () => {
    current = { ...BASE_VISIT, stopTime: "2026-09-25T14:30:00.000Z", totalMinutes: 30 };
    await openPage();
    expect(await screen.findByText("99348")).toBeTruthy();
    expect(screen.queryByText(BASE_NOTE)).toBeNull();
    const sent = await saveDraft();
    expect(sent).toMatchObject({ cptCodesAssigned: ["99348"], totalMinutes: 30, acpMinutes: 0 });
  });
});
