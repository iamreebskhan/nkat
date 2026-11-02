/**
 * @vitest-environment jsdom
 */
/**
 * A care plan that could not be read. The page went on to a blank form, so a
 * role without access read "No saves yet" over a real plan, and a clinician
 * whose load failed had boxes that save on blur, ready to write blanks over it.
 * Found by signing in as an intake coordinator.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/editor/tiptap-editor", () => ({ TipTapEditor: () => null }));

import CarePlanPage from "@/app/(platform)/patients/[id]/care-plan/page";

const fetchMock = vi.fn();
const PLAN = {
  id: "p1",
  patientId: "x",
  document: null,
  goalsOfCareSummary: "Comfort at home",
  primarySymptoms: [],
  activeMedications: [],
  goals: [],
  interventions: [],
  monitoring: [],
  escalation: [],
  reviewOn: null,
  currentVersion: 3,
  lastUpdatedVisit: null,
  updatedAt: "2026-10-01T12:00:00Z",
};

/** The plan answers with `plan`; everything else on the page answers empty. */
const planAnswers = (plan: () => Promise<unknown>) =>
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith("/api/care-plans/x")
      ? plan()
      : { status: 200, json: async () => ({ success: true, data: { rows: [], medications: [] } }) },
  );

const open = async () => {
  await act(async () => {
    render(
      <Suspense fallback="…">
        <CarePlanPage params={Promise.resolve({ id: "x" })} searchParams={Promise.resolve({})} />
      </Suspense>,
    );
  });
};

const goals = () => screen.queryByRole("textbox", { name: "Goals of care" }) as HTMLTextAreaElement | null;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Care plan page, when the plan cannot be read", () => {
  it("tells a role without access so, and shows no plan at all", async () => {
    planAnswers(async () => ({
      status: 403,
      json: async () => ({ success: false, error: "Permission denied: missing careplans.view." }),
    }));
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Your role doesn't open care plans.");
    expect(document.body.textContent).not.toContain("No saves yet");
    expect(goals()).toBeNull();
  });

  it("offers no box to save over the real plan when the server fails", async () => {
    planAnswers(async () => ({ status: 500, json: async () => ({ success: false, error: "Internal error." }) }));
    await open();
    expect(screen.getByRole("alert").textContent).toBe("The care plan could not be loaded.");
    expect(goals()).toBeNull();
  });

  it("nor when the connection fails", async () => {
    planAnswers(() => Promise.reject(new Error("offline")));
    await open();
    expect(screen.getByRole("alert").textContent).toBe("The care plan could not be loaded.");
    expect(goals()).toBeNull();
  });

  it("CONTROL: a plan that loads is shown to edit", async () => {
    planAnswers(async () => ({ status: 200, json: async () => ({ success: true, data: { carePlan: PLAN } }) }));
    await open();
    expect(goals()!.value).toBe("Comfort at home");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("CONTROL: a patient with no plan yet still gets the blank form to start one", async () => {
    planAnswers(async () => ({ status: 200, json: async () => ({ success: true, data: { carePlan: null } }) }));
    await open();
    expect(document.body.textContent).toContain("No saves yet");
    expect(goals()!.value).toBe("");
  });
});
