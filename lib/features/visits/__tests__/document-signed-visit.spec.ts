/**
 * @vitest-environment jsdom
 */
/**
 * /visits/[id]/document once the visit is signed, and the ACP minutes on an
 * open one.
 *
 * Seen on localhost before the fix, on Harold Jennings' visit (signed with
 * 99350 + G0318 at one unit, 140 minutes, Medicare):
 *   - the "Suggested codes" card re-ran live and showed G0318 ×3, codes the
 *     visit was never signed with;
 *   - Start, Stop and ACP minutes stayed editable while every other field was
 *     locked, and typing 30 ACP minutes added 99497 to the card.
 * And on an open 30-minute visit, 40 ACP minutes were suggested 99497 with no
 * word that the ACP time was longer than the visit.
 *
 * The shipped page is rendered with its heavy children stubbed, as in
 * document-acp-base-code.spec.ts.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, Suspense, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sidebar = vi.hoisted(() => ({ codes: null as string[] | null }));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("@/components/billing/rule-sidebar", () => ({
  RuleSidebar: (p: { cptCodes: string[] }) => {
    sidebar.codes = p.cptCodes;
    return null;
  },
}));
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

/** Harold Jennings' visit as the local database holds it: signed, one G0318 unit. */
const SIGNED = {
  id: ID, patientId: PID, clinicianUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  visitType: "established_patient_home", visitTypeLabel: "Established patient — home",
  codingBasis: "established_patient_home", visitTypeIsTelehealth: false,
  scheduledStart: "2026-09-18T13:30:00.000Z", scheduledEnd: null,
  startTime: "2026-09-18T13:30:00.000Z", stopTime: "2026-09-18T15:50:00.000Z", totalMinutes: 140,
  acpMinutes: 0, prolongedMinutes: 0, isTelehealth: false, telehealthModality: null as string | null,
  telehealthConsentDocumented: false, placeOfServiceCode: "12",
  signedByUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | null,
  signerName: "Helen Okafor" as string | null,
  signerCredential: "MD" as string | null,
  documentText: null, cptCodesAssigned: ["99350", "G0318"] as string[], cptUnits: {} as Record<string, number>,
  icd10Codes: ["C34.90"], modifiers: [] as string[],
  status: "pending_billing", signedAt: "2026-09-23T22:07:52.000Z" as string | null,
  createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-23T22:07:52.000Z",
};

/** An open visit, 30 minutes start to stop. */
const OPEN = {
  ...SIGNED,
  stopTime: "2026-09-18T14:00:00.000Z", totalMinutes: 30,
  cptCodesAssigned: [] as string[], status: "in_progress",
  signedByUserId: null, signerName: null, signerCredential: null, signedAt: null,
};

type Visit = typeof SIGNED & Record<string, unknown>;
let current: Visit;
let documentPatches: Record<string, unknown>[];
let transitions: unknown[];
let patientServed: boolean;

beforeEach(() => {
  current = { ...SIGNED };
  documentPatches = [];
  transitions = [];
  patientServed = false;
  sidebar.codes = null;
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
          data: { id: PID, firstName: "Harold", lastName: "Jennings", dateOfBirth: "1941-02-02", primaryPayerType: "medicare_mac", telehealthConsentAt: null },
        };
      } else if (url === "/api/settings/visit-types") body = { success: true, data: { types: [] } };
      else if (url.startsWith(`/api/patients/${PID}/visit-type-hint?`)) {
        body = { success: true, data: { lastVisitAt: null, lastVisitStatus: null, windowStart: "2023-09-18T13:30:00.000Z", suggestedBasis: "established_patient_home" } };
      } else if (url === `/api/visits/${ID}/document` && init?.method === "PATCH") {
        documentPatches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        body = { success: true, data: { updated: true } };
      } else if (url === `/api/visits/${ID}/transition`) {
        transitions.push(JSON.parse(String(init?.body)));
        body = { success: true, data: {} };
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

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

describe("a signed visit shows what was signed", () => {
  it("shows the signed codes and units, not a re-run suggestion", async () => {
    await openPage();
    expect(await screen.findByText("Signed codes")).toBeTruthy();
    expect(screen.queryByText("Suggested codes")).toBeNull();
    expect(screen.getByText("99350")).toBeTruthy();
    // One G0318 unit, as signed — the live suggester makes 140 minutes three.
    expect(screen.getByText("G0318").textContent).toBe("G0318");
    expect(screen.queryByText(/×3/)).toBeNull();
    expect(sidebar.codes).toEqual(["99350", "G0318"]);
  });

  it("shows a signed unit count and modifier as they were signed", async () => {
    current = { ...SIGNED, cptUnits: { G0318: 4 }, modifiers: ["95"] };
    await openPage();
    expect((await screen.findByText("G0318")).textContent).toBe("G0318×4");
    expect(screen.getByText("Modifier 95")).toBeTruthy();
  });

  it("locks Start, Stop, ACP minutes and the telehealth box with the rest of the record", async () => {
    await openPage();
    await screen.findByText("Signed codes");
    expect(field(/^Start/).disabled).toBe(true);
    expect(field(/^Stop/).disabled).toBe(true);
    expect(field(/ACP minutes/).disabled).toBe(true);
    expect((screen.getByLabelText(/This is a telehealth visit/) as HTMLInputElement).disabled).toBe(true);
  });

  it("says so when a Not billed visit was signed with no codes, and points to no bill", async () => {
    current = { ...SIGNED, codingBasis: "non_billable", cptCodesAssigned: [], status: "documented" };
    await openPage();
    expect(await screen.findByText(/was signed with no codes/)).toBeTruthy();
    expect(screen.queryByText(/corrected on the bill/)).toBeNull();
  });

  it("CONTROL: a billed visit's card says where its codes are corrected", async () => {
    await openPage();
    expect(await screen.findByText(/After signing, codes are corrected on the bill\./)).toBeTruthy();
  });

  it("CONTROL: an open visit keeps the live suggestion and editable times", async () => {
    current = { ...SIGNED, status: "in_progress", signedAt: null, signerName: null, signerCredential: null };
    await openPage();
    expect(await screen.findByText("Suggested codes")).toBeTruthy();
    expect(screen.queryByText("Signed codes")).toBeNull();
    expect((await screen.findByText("G0318")).textContent).toBe("G0318×3");
    expect(field(/^Start/).disabled).toBe(false);
    expect(field(/ACP minutes/).disabled).toBe(false);
  });
});

describe("ACP minutes cannot be more than the visit", () => {
  it("says so beside the input, codes nothing, and Sign sends nothing", async () => {
    current = { ...OPEN };
    await openPage();
    expect(await screen.findByText("99348")).toBeTruthy();
    fireEvent.change(field(/ACP minutes/), { target: { value: "40" } });
    const msg =
      "40 minutes of ACP is more than the visit's 30 minutes in total. ACP time is part of the visit: correct the start and stop times, or the ACP minutes.";
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(msg);
    expect(field(/ACP minutes/).getAttribute("aria-describedby")).toBe(alert.id);
    expect(screen.getByText(/Nothing is coded\./)).toBeTruthy();
    expect(screen.queryByText("99497")).toBeNull();
    expect(screen.queryByText("99348")).toBeNull();

    // Beside the input and in the card; Sign adds it as the screen's error.
    const shown = screen.getAllByText(msg).length;
    fireEvent.click(screen.getByRole("button", { name: "Sign + submit for billing" }));
    await waitFor(() => expect(screen.getAllByText(msg).length).toBeGreaterThan(shown));
    expect(screen.queryByText(/Need at least one CPT code/)).toBeNull();
    expect(documentPatches).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("CONTROL: ACP minutes that fill the visit code 99497, with no alert", async () => {
    current = { ...OPEN };
    await openPage();
    fireEvent.change(field(/ACP minutes/), { target: { value: "30" } });
    expect(await screen.findByText("99497")).toBeTruthy();
    expect(screen.queryByText(/minutes of ACP is more than/)).toBeNull();
  });
});
