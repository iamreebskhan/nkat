/**
 * @vitest-environment jsdom
 */
/**
 * The New visit composer on /schedule, rendered and driven as a scheduler
 * drives it — no visit type is chosen for them.
 *
 * It started every visit on "established_patient_home" and kept that whenever
 * the org had the slug (every seeded org does), with no empty option and a
 * Schedule button that checked only patient and clinician. From a chart's
 * "Schedule visit" link the patient comes from ?patientId= and a clinician's own
 * name is filled in, so one click booked an established visit, and a first
 * visit was then coded on the established ladder (99347-99350) instead of the
 * new-patient one (99341-99345).
 *
 * The shipped page is rendered: reading its source is a weak oracle
 * (document-page-truthfulness.spec.ts says as much), and clinician-options.ts
 * records a bug every test missed because none of them rendered the page.
 * Plain createElement rather than JSX: lib specs are .ts.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import SchedulePage from "@/app/(platform)/schedule/page";

const PATIENT = "f0000000-0000-4000-8000-000000000001";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** The four seeded types, in their seeded order, as /api/settings/visit-types returns them. */
const TYPES = [
  { slug: "new_patient_home", label: "New patient — home", codingBasis: "new_patient_home", isTelehealth: false },
  { slug: "established_patient_home", label: "Established patient — home", codingBasis: "established_patient_home", isTelehealth: false },
  { slug: "advance_care_planning", label: "Advance care planning", codingBasis: "advance_care_planning", isTelehealth: false },
  { slug: "telehealth", label: "Established patient — telehealth", codingBasis: "established_patient_home", isTelehealth: true },
];

const NO_PRIOR = {
  lastVisitAt: null,
  lastVisitStatus: null,
  windowStart: "2023-09-26T15:00:00.000Z",
  suggestedBasis: "new_patient_home",
};

let posted: Record<string, unknown>[];
let hintUrls: string[];
/** What the hint route answers: a body, or a refusal. */
let hint: { status: number; body: unknown };
/** Set to leave every later hint request unanswered. */
let hintHangs: boolean;

beforeEach(() => {
  posted = [];
  hintUrls = [];
  hint = { status: 200, body: { success: true, data: NO_PRIOR, error: null } };
  hintHangs = false;
  window.history.replaceState({}, "", `/schedule?patientId=${PATIENT}`);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = { success: false, error: "Not stubbed." };
      let status = 200;
      if (url.startsWith("/api/visits?")) body = { success: true, data: { rows: [], total: 0 } };
      else if (url.startsWith("/api/schedule/context")) body = { success: true, data: { externalBusy: [], timeOff: [] } };
      else if (url.startsWith("/api/patients?")) {
        body = { success: true, data: { rows: [{ id: PATIENT, firstName: "Test", lastName: "Visittype" }] } };
      } else if (url === "/api/team/members?active=1") {
        // A clinician cannot see the roster, so the composer offers them alone.
        body = { success: false, error: "Permission denied." };
        status = 403;
      } else if (url === "/api/auth/me") body = { success: true, data: { userId: ME, email: "priya@example.test", fullName: "Priya Raman" } };
      else if (url === "/api/settings/visit-types") body = { success: true, data: { types: TYPES } };
      else if (url.startsWith(`/api/patients/${PATIENT}/visit-type-hint?`)) {
        hintUrls.push(url);
        if (hintHangs) return new Promise<Response>(() => {});
        ({ status, body } = hint);
      } else if (url === "/api/visits" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        body = { success: true, data: { id: "e0000000-0000-4000-8000-00000000000a" } };
        status = 201;
      }
      return Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(body) } as Response);
    }),
  );
  vi.spyOn(window, "confirm").mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The page, opened from a chart's "Schedule visit" link, with everything loaded. */
async function openComposer() {
  render(createElement(SchedulePage));
  const select = (await screen.findByLabelText(/Visit type/)) as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBeGreaterThanOrEqual(TYPES.length));
  const patient = screen.getByLabelText(/Patient/) as HTMLSelectElement;
  const clinician = screen.getByLabelText(/Clinician/) as HTMLSelectElement;
  await waitFor(() => expect(patient.value).toBe(PATIENT));
  await waitFor(() => expect(clinician.value).toBe(ME));
  return { select, button: screen.getByRole("button", { name: "Schedule visit" }) as HTMLButtonElement };
}

const NO_PRIOR_TEXT = /No visit for this patient in Pallio in the 3 years before this date/;

describe("New visit composer — the visit type", () => {
  it("starts with no visit type, and Schedule stays off until one is chosen", async () => {
    const { select, button } = await openComposer();
    expect(select.value).toBe("");
    expect(select.required).toBe(true);
    expect(button.disabled).toBe(true);
    // Pressing it anyway (it is disabled) books nothing.
    fireEvent.click(button);
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toEqual([]);
  });

  it("CONTROL — choosing a type enables Schedule and posts exactly that type", async () => {
    const { select, button } = await openComposer();
    fireEvent.change(select, { target: { value: "new_patient_home" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ patientId: PATIENT, clinicianUserId: ME, visitType: "new_patient_home" });
  });

  it("says what Pallio's history shows, for the date being booked, and still picks nothing", async () => {
    const { select } = await openComposer();
    expect(await screen.findByText(NO_PRIOR_TEXT)).toBeTruthy();
    expect(screen.getByText(/If your practice saw them outside Pallio/)).toBeTruthy();
    expect(select.value).toBe("");
    // Asked for the scheduled start, as an instant.
    const at = new URL(hintUrls[hintUrls.length - 1]!, "http://x").searchParams.get("at")!;
    const start = (screen.getByLabelText(/Scheduled start/) as HTMLInputElement).value;
    expect(at).toBe(new Date(start).toISOString());
  });

  it("names an earlier visit, and warns when a new-patient type is chosen after it", async () => {
    hint = {
      status: 200,
      body: {
        success: true,
        data: { ...NO_PRIOR, lastVisitAt: "2026-03-10T15:00:00.000Z", lastVisitStatus: "documented", suggestedBasis: "established_patient_home" },
        error: null,
      },
    };
    const { select } = await openComposer();
    expect(await screen.findByText(/Seen in this practice on .*an Established type fits/)).toBeTruthy();
    expect(screen.queryByText(/payers treat a new-patient code/)).toBeNull();
    fireEvent.change(select, { target: { value: "new_patient_home" } });
    expect(await screen.findByText(/payers treat a new-patient code within 3 years/)).toBeTruthy();
  });

  it("says a booked earlier visit is only booked", async () => {
    hint = {
      status: 200,
      body: {
        success: true,
        data: { ...NO_PRIOR, lastVisitAt: "2026-03-10T15:00:00.000Z", lastVisitStatus: "scheduled", suggestedBasis: "established_patient_home" },
        error: null,
      },
    };
    await openComposer();
    expect(await screen.findByText(/Booked in this practice for .*if that visit takes place, this one is Established/)).toBeTruthy();
  });

  it("warns when an Established type is chosen for a patient Pallio has never seen", async () => {
    const { select } = await openComposer();
    await screen.findByText(NO_PRIOR_TEXT);
    expect(screen.queryByText(/Pallio has no visit for this patient/)).toBeNull();
    fireEvent.change(select, { target: { value: "established_patient_home" } });
    expect(await screen.findByText(/Pallio has no visit for this patient/)).toBeTruthy();
    // CONTROL: the band the history points to carries no warning.
    fireEvent.change(select, { target: { value: "new_patient_home" } });
    await waitFor(() => expect(screen.queryByText(/Pallio has no visit for this patient/)).toBeNull());
  });

  it("shows no hint and no error when the hint is refused", async () => {
    hint = { status: 403, body: { success: false, data: null, error: "Permission denied." } };
    const { select, button } = await openComposer();
    await waitFor(() => expect(hintUrls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(NO_PRIOR_TEXT)).toBeNull();
    expect(screen.queryByText(/Seen in this practice/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // The composer still works.
    fireEvent.change(select, { target: { value: "new_patient_home" } });
    expect(button.disabled).toBe(false);
  });

  it("drops the line as soon as the time changes, before the new answer arrives", async () => {
    // A hint is about one patient on one date. The line for the old time must
    // not sit under the select while the new one is still being asked for, or
    // a slow answer shows "Seen … an Established type fits" against a booking
    // it was never about.
    hint = {
      status: 200,
      body: {
        success: true,
        data: { ...NO_PRIOR, lastVisitAt: "2026-03-10T15:00:00.000Z", lastVisitStatus: "documented", suggestedBasis: "established_patient_home" },
        error: null,
      },
    };
    await openComposer();
    expect(await screen.findByText(/Seen in this practice on/)).toBeTruthy();
    hintHangs = true;
    fireEvent.change(screen.getByLabelText(/Scheduled start/), { target: { value: "2029-12-01T10:00" } });
    expect(screen.queryByText(/Seen in this practice on/)).toBeNull();
    // Still gone once the new request has gone out unanswered.
    await waitFor(() => expect(hintUrls[hintUrls.length - 1]).toContain(encodeURIComponent(new Date("2029-12-01T10:00").toISOString())));
    expect(screen.queryByText(/Seen in this practice on/)).toBeNull();
  });

  it("asks once for a burst of edits: every hint is a logged read of the patient's history", async () => {
    await openComposer();
    await screen.findByText(NO_PRIOR_TEXT);
    const asked = hintUrls.length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const start = screen.getByLabelText(/Scheduled start/);
    // Typing a time: three edits 100 ms apart.
    for (const value of ["2029-12-01T10:00", "2029-12-01T11:00", "2029-12-01T12:00"]) {
      fireEvent.change(start, { target: { value } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    expect(hintUrls).toHaveLength(asked);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(hintUrls).toHaveLength(asked + 1);
    expect(hintUrls[hintUrls.length - 1]).toContain(encodeURIComponent(new Date("2029-12-01T12:00").toISOString()));
  });
});
