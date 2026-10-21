/**
 * @vitest-environment jsdom
 */
/**
 * Moving a visit on the /schedule grid onto a full day, or onto a slot Google
 * Calendar has busy, asks before moving it anyway — as the New visit form asks
 * before booking anyway.
 *
 * The reschedule route now answers 409 for those, as booking does. The grid
 * showed any refusal in an alert and stopped, so without this a scheduler
 * could not move a visit onto a full day at all.
 *
 * The shipped page is rendered and driven by tap-to-move: tap the visit's Move
 * button, then a day.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import SchedulePage from "@/app/(platform)/schedule/page";

const VISIT = "e0000000-0000-4000-8000-00000000000a";
const FULL = "This clinician already has 6 visit(s) that day (cap 6).";

/** 3 pm today, so the visit is on the week the grid opens on. */
const today3pm = () => {
  const d = new Date();
  d.setHours(15, 0, 0, 0);
  return d.toISOString();
};

let patches: Record<string, unknown>[];
/** What each PATCH answers, in order. */
let answers: { status: number; body: unknown }[];
let confirmMessages: string[];
let confirmAnswer: boolean;

beforeEach(() => {
  patches = [];
  confirmMessages = [];
  confirmAnswer = true;
  answers = [
    { status: 409, body: { success: false, data: null, error: FULL } },
    { status: 200, body: { success: true, data: { updated: true }, error: null } },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let status = 200;
      let body: unknown = { success: false, error: "Not stubbed." };
      if (url.startsWith("/api/visits?")) {
        body = {
          success: true,
          data: {
            rows: [
              {
                id: VISIT, patientId: "f0000000-0000-4000-8000-000000000001", patientName: "Test Visittype",
                clinicianUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", clinicianName: "Priya Raman",
                visitType: "established_patient_home", status: "scheduled",
                scheduledStart: today3pm(), scheduledEnd: null, startTime: null, isTelehealth: false,
              },
            ],
            total: 1,
          },
        };
      } else if (url.startsWith("/api/schedule/context")) body = { success: true, data: { externalBusy: [], timeOff: [] } };
      else if (url === `/api/visits/${VISIT}/reschedule` && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        ({ status, body } = answers[patches.length - 1] ?? { status: 500, body: { success: false, error: "extra" } });
      }
      return Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(body) } as Response);
    }),
  );
  vi.spyOn(window, "confirm").mockImplementation((m?: string) => {
    confirmMessages.push(String(m));
    return confirmAnswer;
  });
  vi.spyOn(window, "alert").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Tap the visit's Move button, then a day: the visit's own day here. */
async function moveTheVisit() {
  await act(async () => {
    render(createElement(SchedulePage));
  });
  const move = await screen.findByRole("button", { name: "Move Test Visittype" });
  fireEvent.click(move);
  // The day column is the drop target while a move is in flight; its header
  // shows the day of the month.
  const column = move.closest("li")!.parentElement!.parentElement!;
  fireEvent.click(column);
}

describe("moving a visit onto a full day, or a busy slot", () => {
  it("asks, naming why, and on yes moves it anyway", async () => {
    await moveTheVisit();
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(confirmMessages).toEqual([`${FULL}\n\nMove it anyway?`]);
    expect(patches[0]).not.toHaveProperty("confirmDoubleBook");
    expect(patches[1]).toEqual({ scheduledStart: patches[0]!.scheduledStart, confirmDoubleBook: true });
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("on no, leaves the visit where it is and says nothing more", async () => {
    confirmAnswer = false;
    await moveTheVisit();
    await waitFor(() => expect(confirmMessages).toHaveLength(1));
    expect(patches).toHaveLength(1);
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("CONTROL: a move the route takes at once asks nothing", async () => {
    answers = [{ status: 200, body: { success: true, data: { updated: true }, error: null } }];
    await moveTheVisit();
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("CONTROL: any other refusal is still shown as before", async () => {
    answers = [{ status: 404, body: { success: false, data: null, error: "Visit not found or not reschedulable." } }];
    await moveTheVisit();
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith("Visit not found or not reschedulable."));
    expect(window.confirm).not.toHaveBeenCalled();
  });
});
