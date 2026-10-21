/**
 * @vitest-environment jsdom
 */
/**
 * The Visit type card on /visits/[id]/document — the one place a visit's type
 * can be corrected before it is signed.
 *
 * The type used to appear only in the heading. The screen coded from it, told
 * the clinician to "pick a visit type" when nothing came out, and offered
 * nowhere to pick one, so a first visit booked on the established default
 * reached the bill as 99349 instead of 99342.
 *
 * The shipped page is rendered with its seven heavy children stubbed, and
 * driven the way a clinician drives it: unsaved Start/Stop/ACP must survive the
 * change, the note is flushed before it and re-mounted after it (its required
 * sections follow the type), and a telehealth type ticks the box the next save
 * sends. A change the server made stays on screen when the reload after it
 * fails, and every save says which type its codes were worked out for, so a
 * screen left on an old type is refused instead of writing the old band's codes.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, Suspense, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const note = vi.hoisted(() => ({ mounts: 0, flushResult: true, events: [] as string[] }));

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
vi.mock("@/components/visits/sectioned-note", async () => {
  const React = await import("react");
  return {
    SectionedNote: (props: { registerFlush?: (fn: () => Promise<boolean>) => void }) => {
      // Counts mounts, not renders: the page re-keys the note after a type
      // change so its required sections are loaded again.
      React.useState(() => {
        note.mounts++;
        return null;
      });
      props.registerFlush?.(async () => {
        note.events.push("flush");
        return note.flushResult;
      });
      return null;
    },
  };
});

import VisitDocumentPage from "@/app/(platform)/visits/[id]/document/page";

const ID = "e0000000-0000-4000-8000-00000000000a";
const PID = "f0000000-0000-4000-8000-000000000001";

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
  { slug: "advance_care_planning", label: "Advance care planning", codingBasis: "advance_care_planning", isTelehealth: false },
  { slug: "telehealth", label: "Established patient — telehealth", codingBasis: "established_patient_home", isTelehealth: true },
];

const BASE_VISIT = {
  id: ID, patientId: PID, clinicianUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  visitType: "established_patient_home", visitTypeLabel: "Established patient — home",
  codingBasis: "established_patient_home", visitTypeIsTelehealth: false,
  scheduledStart: "2026-09-25T14:00:00.000Z", scheduledEnd: null,
  startTime: "2026-09-25T14:00:00.000Z", stopTime: "2026-09-25T14:45:00.000Z", totalMinutes: 45,
  acpMinutes: 0, prolongedMinutes: 0, isTelehealth: false, telehealthModality: null as string | null,
  telehealthConsentDocumented: false, placeOfServiceCode: "12",
  signedByUserId: null, signerName: null, signerCredential: null, documentText: null,
  cptCodesAssigned: ["99349"], cptUnits: {}, icd10Codes: ["C34.90"], modifiers: [],
  status: "in_progress", signedAt: null as string | null,
  createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
};

const NO_PRIOR = { lastVisitAt: null, lastVisitStatus: null, windowStart: "2023-09-25T14:00:00.000Z", suggestedBasis: "new_patient_home" };

type Visit = typeof BASE_VISIT & Record<string, unknown>;
let current: Visit;
let perms: string[];
let hintData: unknown;
let hintUrls: string[];
let typePatches: unknown[];
let documentPatches: Record<string, unknown>[];
let transitions: unknown[];
/** How many times the "Note against bill" findings were read. */
let reconciliations: number;
/** Set to make PATCH /visit-type refuse with this message, changing nothing. */
let typePatchRefusal: string | null;
/** What GET /api/visits/[id] does once a type change has been made. */
let reloadAfterChange: "ok" | "throws" | "refused";
let changesMade: number;
/** False: /api/billing/code-bands refuses, so nothing can be suggested. */
let bandsLoad: boolean;

/** documentVisit's refusal of a save coded on a type that has since changed. */
const STALE_TYPE =
  "This visit's type was changed after this screen loaded it, so its codes were worked out for the old type. Nothing was saved — reload the page.";

beforeEach(() => {
  note.mounts = 0;
  note.flushResult = true;
  note.events = [];
  current = { ...BASE_VISIT };
  perms = ["visits.view.own", "visits.edit", "visits.submit", "patients.view"];
  hintData = NO_PRIOR;
  hintUrls = [];
  typePatches = [];
  documentPatches = [];
  transitions = [];
  reconciliations = 0;
  typePatchRefusal = null;
  reloadAfterChange = "ok";
  changesMade = 0;
  bandsLoad = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = { success: false, data: null, error: "Not stubbed." };
      let status = 200;
      if (url === `/api/visits/${ID}` && !init?.method) {
        if (changesMade > 0 && reloadAfterChange === "throws") return Promise.reject(new TypeError("Failed to fetch"));
        body =
          changesMade > 0 && reloadAfterChange === "refused"
            ? { success: false, data: null, error: "Internal error." }
            : { success: true, data: current };
      } else if (url === "/api/billing/code-bands") {
        body = bandsLoad ? { success: true, data: BANDS } : { success: false, data: null, error: "Internal error." };
      }
      else if (url === "/api/auth/me") body = { success: true, data: { permissions: perms, role: "clinician" } };
      else if (url === `/api/visits/${ID}/reconciliation`) {
        reconciliations++;
        body = { success: true, data: { findings: [] } };
      } else if (url === `/api/patients/${PID}`) {
        body = {
          success: true,
          data: { id: PID, firstName: "Test", lastName: "Visittype", dateOfBirth: "1940-01-01", primaryPayerType: "medicare_mac", telehealthConsentAt: null },
        };
      } else if (url === "/api/settings/visit-types") body = { success: true, data: { types: TYPES } };
      else if (url.startsWith(`/api/patients/${PID}/visit-type-hint?`)) {
        hintUrls.push(url);
        body = { success: true, data: hintData };
      } else if (url === `/api/visits/${ID}/visit-type` && init?.method === "PATCH") {
        const sent = JSON.parse(String(init.body)) as { visitType: string };
        note.events.push("patch");
        typePatches.push(sent);
        if (typePatchRefusal) {
          body = { success: false, data: null, error: typePatchRefusal };
          status = 422;
        } else {
          // What changeVisitType writes and answers.
          const t = TYPES.find((x) => x.slug === sent.visitType)!;
          const fromBasis = current.codingBasis;
          const cleared = t.codingBasis !== fromBasis;
          current = {
            ...current,
            visitType: t.slug,
            visitTypeLabel: t.label,
            codingBasis: t.codingBasis,
            visitTypeIsTelehealth: t.isTelehealth,
            isTelehealth: current.isTelehealth || t.isTelehealth,
            cptCodesAssigned: cleared ? [] : current.cptCodesAssigned,
          };
          changesMade++;
          body = { success: true, data: { changed: true, codesCleared: cleared, fromBasis, toBasis: t.codingBasis } };
        }
      } else if (url === `/api/visits/${ID}/document` && init?.method === "PATCH") {
        const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        documentPatches.push(sent);
        // documentVisit's rule (run for real in document-visit-stale-type.spec.ts):
        // a save that says which type it coded for is refused once that is no
        // longer the visit's type.
        if (sent.visitType !== undefined && sent.visitType !== current.visitType) {
          body = { success: false, data: null, error: STALE_TYPE };
          status = 422;
        } else body = { success: true, data: { updated: true } };
      } else if (url === `/api/visits/${ID}/transition` && init?.method === "POST") {
        transitions.push(JSON.parse(String(init.body)));
        body = { success: true, data: { superbillId: null } };
      }
      return Promise.resolve({ status, json: () => Promise.resolve(body) } as Response);
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
}

const typeSelect = () => screen.findByRole("combobox", { name: /Visit type/ }) as Promise<HTMLSelectElement>;
const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

async function changeTo(slug: string, confirmed = true) {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(confirmed);
  const select = await typeSelect();
  // A change still running holds the card; wait for it as a clinician would.
  await waitFor(() => expect(select.disabled).toBe(false));
  fireEvent.change(select, { target: { value: slug } });
  fireEvent.click(screen.getByRole("button", { name: "Change visit type" }));
  return confirm;
}

const saveDraft = () => fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

describe("the Visit type card", () => {
  it("corrects the type in place: new code, unsaved ACP minutes kept, note flushed then re-mounted", async () => {
    await openPage();
    expect(await screen.findByText("99349")).toBeTruthy();
    expect((await typeSelect()).value).toBe("established_patient_home");
    // Unsaved: typed, never saved. The change must not reload it away.
    fireEvent.change(screen.getByLabelText(/ACP minutes/), { target: { value: "20" } });
    expect(await screen.findByText("99497")).toBeTruthy();
    // The 20 ACP minutes bill as 99497, so the base code is chosen on the 25
    // E/M minutes left of the 45: 99347, not 99349.
    expect(await screen.findByText("99347")).toBeTruthy();
    expect(screen.queryByText("99349")).toBeNull();
    await waitFor(() => expect(reconciliations).toBe(1));

    const confirm = await changeTo("new_patient_home");
    await waitFor(() => expect(heading()).toContain("New patient — home"));
    expect(confirm.mock.calls[0]![0]).toMatch(/re-runs the code suggestion and clears the codes already saved/);
    expect(typePatches).toEqual([{ visitType: "new_patient_home" }]);
    expect(note.events).toEqual(["flush", "patch"]);
    await waitFor(() => expect(note.mounts).toBe(2));
    // The "Note against bill" findings are read again for the new type.
    await waitFor(() => expect(reconciliations).toBe(2));

    // 25 E/M minutes on the new-patient ladder (15–29).
    expect(screen.getByText("99341")).toBeTruthy();
    expect(screen.getByText("99497")).toBeTruthy();
    expect(screen.queryByText("99349")).toBeNull();
    expect((screen.getByLabelText(/ACP minutes/) as HTMLInputElement).value).toBe("20");
    expect((await typeSelect()).value).toBe("new_patient_home");
    // The hint is asked again, for this visit's own date and leaving it out.
    await waitFor(() => expect(hintUrls).toHaveLength(2));
    const q = new URL(hintUrls[1]!, "http://x").searchParams;
    expect(q.get("excludeVisitId")).toBe(ID);
    expect(q.get("at")).toBe(BASE_VISIT.startTime);
  });

  it("a telehealth type ticks the box and moves the place of service, and Save draft sends both", async () => {
    await openPage();
    const confirm = await changeTo("telehealth");
    await waitFor(() => expect(heading()).toContain("Established patient — telehealth"));
    // Same band: the confirmation promises no cleared codes, because none are.
    expect(confirm.mock.calls[0]![0]).toBe("Changing the visit type re-runs the code suggestion.");
    const box = screen.getByRole("checkbox", { name: /This is a telehealth visit/ }) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    expect(box.disabled).toBe(true);
    saveDraft();
    await waitFor(() => expect(documentPatches).toHaveLength(1));
    expect(documentPatches[0]).toMatchObject({ isTelehealth: true, placeOfServiceCode: "10", visitType: "telehealth" });
  });

  it("to telehealth and back in one sitting: unticked by the clinician, saved as an in-person visit", async () => {
    await openPage();
    await changeTo("telehealth");
    await waitFor(() => expect(heading()).toContain("Established patient — telehealth"));
    await changeTo("new_patient_home");
    await waitFor(() => expect(heading()).toContain("New patient — home"));
    const box = screen.getByRole("checkbox", { name: /This is a telehealth visit/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    expect(screen.getByText(/Telehealth is still ticked from the previous type/)).toBeTruthy();
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    saveDraft();
    await waitFor(() => expect(documentPatches).toHaveLength(1));
    expect(documentPatches[0]).toMatchObject({
      isTelehealth: false,
      placeOfServiceCode: "12",
      cptCodesAssigned: ["99342"],
      visitType: "new_patient_home",
    });
  });

  it("a refused change leaves the screen as it was, and says why", async () => {
    typePatchRefusal = "This visit was signed while the type was being changed — nothing was changed.";
    await openPage();
    expect(await screen.findByText("99349")).toBeTruthy();
    await waitFor(() => expect(reconciliations).toBe(1));
    await changeTo("new_patient_home");
    expect(await screen.findAllByText(/signed while the type was being changed/)).not.toHaveLength(0);
    expect(typePatches).toEqual([{ visitType: "new_patient_home" }]);
    expect(heading()).toContain("Established patient — home");
    expect(screen.getByText("99349")).toBeTruthy();
    expect(screen.queryByText("99342")).toBeNull();
    // Nothing that follows a change ran: no re-mount, no re-read.
    await new Promise((r) => setTimeout(r, 20));
    expect(note.mounts).toBe(1);
    expect(reconciliations).toBe(1);
    expect(hintUrls).toHaveLength(1);
  });

  it.each(["throws", "refused"] as const)(
    "a change the server made stays on screen when the reload after it %s — and Save draft sends the new band's code",
    async (mode) => {
      // The PATCH succeeded, so the visit IS new_patient_home with no codes.
      // The screen used to learn that only from the reload; when the reload
      // failed it stayed on the established band and its next save wrote 99349
      // back.
      reloadAfterChange = mode;
      await openPage();
      expect(await screen.findByText("99349")).toBeTruthy();
      await changeTo("new_patient_home");
      await waitFor(() => expect(heading()).toContain("New patient — home"));
      // The change, reload included, has finished.
      const select = await typeSelect();
      await waitFor(() => expect(select.disabled).toBe(false));
      expect(screen.getByText("99342")).toBeTruthy();
      expect(screen.queryByText("99349")).toBeNull();
      // Nothing went wrong that the clinician must act on.
      expect(screen.queryByText(/Network error|could not be reloaded/)).toBeNull();
      saveDraft();
      await waitFor(() => expect(documentPatches).toHaveLength(1));
      expect(documentPatches[0]).toMatchObject({ cptCodesAssigned: ["99342"], visitType: "new_patient_home" });
      expect(documentPatches[0]!.cptCodesAssigned).not.toContain("99349");
    },
  );

  it("with no code ladders to suggest from, a save after the change does not send back the codes it cleared", async () => {
    // Save draft falls back to the codes the visit holds when nothing can be
    // suggested. The change cleared them on the server; the screen has to know
    // that without the reload, or the fallback sends 99349 back.
    bandsLoad = false;
    reloadAfterChange = "throws";
    await openPage();
    expect(await screen.findByText(/Codes are unavailable/)).toBeTruthy();
    await changeTo("new_patient_home");
    await waitFor(() => expect(heading()).toContain("New patient — home"));
    const select = await typeSelect();
    await waitFor(() => expect(select.disabled).toBe(false));
    saveDraft();
    await waitFor(() => expect(documentPatches).toHaveLength(1));
    expect(documentPatches[0]).toMatchObject({ cptCodesAssigned: [], cptUnits: {}, visitType: "new_patient_home" });
  });

  it("a screen whose visit's type was changed elsewhere cannot save or sign the old band's codes", async () => {
    await openPage();
    expect(await screen.findByText("99349")).toBeTruthy();
    // An admin corrects the type while this screen is open on the old one.
    current = {
      ...current,
      visitType: "new_patient_home",
      visitTypeLabel: "New patient — home",
      codingBasis: "new_patient_home",
      cptCodesAssigned: [],
    };
    fireEvent.click(screen.getByRole("button", { name: "Sign + submit for billing" }));
    expect(await screen.findAllByText(/type was changed after this screen loaded it/)).not.toHaveLength(0);
    // The screen said what it coded for, the save was refused, and so nothing
    // was signed.
    expect(documentPatches).toHaveLength(1);
    expect(documentPatches[0]).toMatchObject({ visitType: "established_patient_home", cptCodesAssigned: ["99349"] });
    expect(transitions).toEqual([]);
  });

  it("leaving a telehealth type keeps the box ticked but offers it back, and says so", async () => {
    current = {
      ...BASE_VISIT,
      visitType: "telehealth", visitTypeLabel: "Established patient — telehealth",
      visitTypeIsTelehealth: true, isTelehealth: true, telehealthModality: "audio_video", placeOfServiceCode: "10",
    };
    await openPage();
    await changeTo("new_patient_home");
    await waitFor(() => expect(heading()).toContain("New patient — home"));
    const box = screen.getByRole("checkbox", { name: /This is a telehealth visit/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    expect(screen.getByText(/Telehealth is still ticked from the previous type/)).toBeTruthy();
  });

  it("CONTROL — declining the confirmation changes nothing", async () => {
    await openPage();
    const confirm = await changeTo("new_patient_home", false);
    expect(confirm).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(typePatches).toEqual([]);
    expect(heading()).toContain("Established patient — home");
  });

  it("stops before the change when the note could not be saved", async () => {
    note.flushResult = false;
    await openPage();
    await changeTo("new_patient_home");
    expect(await screen.findAllByText(/could not be saved, so the visit type was not changed/)).not.toHaveLength(0);
    expect(typePatches).toEqual([]);
  });

  it("warns when Pallio has no earlier visit for a patient booked as established", async () => {
    await openPage();
    expect(await screen.findByText(/Pallio has no visit for this patient in the 3 years before this visit/)).toBeTruthy();
    // CONTROL: with an earlier visit on record, an established type draws no warning…
    cleanup();
    hintData = { ...NO_PRIOR, lastVisitAt: "2026-03-10T15:00:00.000Z", lastVisitStatus: "documented", suggestedBasis: "established_patient_home" };
    await openPage();
    await waitFor(() => expect(hintUrls.length).toBeGreaterThan(1));
    await typeSelect();
    expect(screen.queryByText(/Pallio has no visit for this patient/)).toBeNull();
    // …and a new-patient one does.
    await changeTo("new_patient_home");
    expect(await screen.findByText(/payers treat a new-patient code within 3 years of a visit by this practice as established/)).toBeTruthy();
  });

  it("offers a type that has since been switched off as the visit's own, not as a different one", async () => {
    current = { ...BASE_VISIT, visitType: "retired_type", visitTypeLabel: "Retired custom type" };
    await openPage();
    const select = await typeSelect();
    expect(select.value).toBe("retired_type");
    const own = Array.from(select.options).find((o) => o.value === "retired_type")!;
    expect(own.textContent).toBe("Retired custom type");
    expect(own.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Change visit type" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows only the label to someone without visits.edit, and does not read the patient's history for them", async () => {
    perms = ["visits.view.all", "patients.view", "billing.superbills.view"];
    await openPage();
    await screen.findByText("99349");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("combobox", { name: /Visit type/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change visit type" })).toBeNull();
    expect(screen.getAllByText("Established patient — home").length).toBeGreaterThan(0);
    expect(hintUrls).toEqual([]);
  });

  it("shows only the label on a signed visit", async () => {
    current = { ...BASE_VISIT, status: "documented", signedAt: "2026-09-25T15:00:00.000Z" };
    await openPage();
    await screen.findByText("99349");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("combobox", { name: /Visit type/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change visit type" })).toBeNull();
    expect(hintUrls).toEqual([]);
  });
});
