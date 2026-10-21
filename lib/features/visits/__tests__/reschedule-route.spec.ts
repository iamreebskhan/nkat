/**
 * PATCH /api/visits/[id]/reschedule makes the checks booking makes, and moves
 * the clinician's Google Calendar event with the visit.
 *
 * Booking a visit (POST /api/visits) refused a full day and a slot Google
 * Calendar had busy, unless the caller confirmed; dragging a visit on the grid
 * did neither, so a visit could be moved onto a day it could never have been
 * booked into. And the move never reached Google: the clinician's calendar
 * kept the visit at its old time.
 *
 * The route runs as shipped. Its services are replaced so each check's answer
 * can be set, except endAfterMove, the real rule for a moved visit's end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/features/visits/visit-access", () => ({ requireVisitAccess: vi.fn() }));
vi.mock("@/lib/features/visits/visit.service", async (importOriginal) => ({
  endAfterMove: (await importOriginal<typeof import("@/lib/features/visits/visit.service")>()).endAfterMove,
  getVisit: vi.fn(),
  getDailyCapacityStatus: vi.fn(),
  rescheduleVisit: vi.fn(),
}));
vi.mock("@/lib/features/calendar/google-calendar.service", () => ({
  getBusyForClinician: vi.fn(),
  pushVisitToGoogle: vi.fn(),
}));

import { type NextRequest } from "next/server";

import { PATCH } from "@/app/api/visits/[id]/reschedule/route";
import { requireAuth } from "@/lib/auth";
import { getBusyForClinician, pushVisitToGoogle } from "@/lib/features/calendar/google-calendar.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";
import { getDailyCapacityStatus, getVisit, rescheduleVisit } from "@/lib/features/visits/visit.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000a";
const PATIENT = "f0000000-0000-4000-8000-000000000001";
/** The scheduler dragging the visit, and the clinician whose visit it is. */
const HELEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRIYA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** 9:00–10:00 on the 29th; moved to 9:00 on the 30th unless a test says otherwise. */
const NOW_START = "2026-09-29T13:00:00.000Z";
const NOW_END = "2026-09-29T14:00:00.000Z";
const NEW_START = "2026-09-30T13:00:00.000Z";
const NEW_END = "2026-09-30T14:00:00.000Z";

const visit = (over: Record<string, unknown> = {}) => ({
  id: VISIT, patientId: PATIENT, clinicianUserId: PRIYA, visitType: "established_patient_home",
  status: "scheduled", scheduledStart: NOW_START, scheduledEnd: NOW_END, ...over,
});

const patch = async (body: Record<string, unknown>) => {
  const res = await PATCH(
    new Request(`http://localhost/api/visits/${VISIT}/reschedule`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: VISIT }) },
  );
  return { status: res.status, body: (await res.json()) as { success: boolean; data: unknown; error: string | null } };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({
    userId: HELEN, orgId: ORG, role: "org_admin", email: "helen@example.test",
    permissions: ["schedule.edit", "visits.view.all"],
  } as never);
  vi.mocked(requireVisitAccess).mockResolvedValue(null);
  vi.mocked(getVisit).mockResolvedValue(visit() as never);
  vi.mocked(getDailyCapacityStatus).mockResolvedValue({ count: 2, capacity: 6, over: false });
  vi.mocked(getBusyForClinician).mockResolvedValue([]);
  vi.mocked(pushVisitToGoogle).mockResolvedValue({ externalId: "ev-1", created: false });
  vi.mocked(rescheduleVisit).mockResolvedValue({
    updated: true,
    moved: { clinicianUserId: PRIYA, patientId: PATIENT, visitType: "established_patient_home", start: NEW_START, end: NEW_END },
  });
});

describe("the day's capacity", () => {
  it("refuses a move onto a full day with 409, naming the count and the cap, and moves nothing", async () => {
    vi.mocked(getDailyCapacityStatus).mockResolvedValue({ count: 6, capacity: 6, over: true });
    const r = await patch({ scheduledStart: NEW_START });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("This clinician already has 6 visit(s) that day (cap 6).");
    expect(rescheduleVisit).not.toHaveBeenCalled();
    expect(pushVisitToGoogle).not.toHaveBeenCalled();
  });

  it("counts the visit's own clinician's day, leaving out the visit being moved", async () => {
    await patch({ scheduledStart: NEW_START });
    expect(getDailyCapacityStatus).toHaveBeenCalledWith({
      orgId: ORG, clinicianUserId: PRIYA, at: NEW_START, excludeVisitId: VISIT,
    });
  });

  it("moves it anyway when the caller confirms, without asking again", async () => {
    vi.mocked(getDailyCapacityStatus).mockResolvedValue({ count: 6, capacity: 6, over: true });
    const r = await patch({ scheduledStart: NEW_START, confirmDoubleBook: true });
    expect(r.status).toBe(200);
    expect(getDailyCapacityStatus).not.toHaveBeenCalled();
    expect(getBusyForClinician).not.toHaveBeenCalled();
    expect(rescheduleVisit).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: a day under its cap and a free slot move straight through", async () => {
    const r = await patch({ scheduledStart: NEW_START });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ updated: true });
  });
});

describe("Google Calendar conflicts", () => {
  it("refuses a slot the clinician's Google Calendar has busy with 409", async () => {
    vi.mocked(getBusyForClinician).mockResolvedValue([{ start: NEW_START, end: NEW_END, summary: "" }]);
    const r = await patch({ scheduledStart: NEW_START });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Conflict with existing Google Calendar events.");
    expect(rescheduleVisit).not.toHaveBeenCalled();
  });

  it("asks about the window the visit will take there: its own length, on its clinician's calendar", async () => {
    await patch({ scheduledStart: NEW_START });
    expect(getBusyForClinician).toHaveBeenCalledWith({
      orgId: ORG, userId: PRIYA, fromIso: NEW_START, toIso: NEW_END,
    });
  });

  it("does not ask when the new slot overlaps the visit's own, whose event would read as a conflict", async () => {
    // Half an hour later the same morning.
    await patch({ scheduledStart: "2026-09-29T13:30:00.000Z" });
    expect(getBusyForClinician).not.toHaveBeenCalled();
    // The day's capacity is still checked.
    expect(getDailyCapacityStatus).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: a calendar Pallio cannot reach is no reason to refuse", async () => {
    vi.mocked(getBusyForClinician).mockRejectedValue(new Error("Calendar not connected for this user."));
    expect((await patch({ scheduledStart: NEW_START })).status).toBe(200);
  });
});

describe("the clinician's Google Calendar event moves with the visit", () => {
  it("is updated to the new start and end, on the clinician's calendar, as booking writes it", async () => {
    await patch({ scheduledStart: NEW_START });
    expect(pushVisitToGoogle).toHaveBeenCalledWith({
      orgId: ORG,
      userId: PRIYA,
      visitId: VISIT,
      startIso: NEW_START,
      endIso: NEW_END,
      summary: "Pallio visit (established_patient_home)",
      description: `Patient ${PATIENT}`,
    });
  });

  it("blocks an hour for a visit with no end, as booking does", async () => {
    vi.mocked(rescheduleVisit).mockResolvedValue({
      updated: true,
      moved: { clinicianUserId: PRIYA, patientId: PATIENT, visitType: "established_patient_home", start: NEW_START, end: null },
    });
    await patch({ scheduledStart: NEW_START });
    expect(vi.mocked(pushVisitToGoogle).mock.calls[0]![0]).toMatchObject({ startIso: NEW_START, endIso: NEW_END });
  });

  it("is left alone when nothing moved", async () => {
    vi.mocked(rescheduleVisit).mockResolvedValue({ updated: true });
    expect((await patch({ scheduledStart: NOW_START })).status).toBe(200);
    expect(pushVisitToGoogle).not.toHaveBeenCalled();
  });

  it("never fails the move: Google refusing the update still answers 200", async () => {
    vi.mocked(pushVisitToGoogle).mockRejectedValue(new Error("Google event update failed (500)"));
    const r = await patch({ scheduledStart: NEW_START });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ updated: true });
  });

  it("CONTROL: a visit that is not reschedulable is not found, and no event is touched", async () => {
    vi.mocked(rescheduleVisit).mockResolvedValue({ updated: false });
    const r = await patch({ scheduledStart: NEW_START });
    expect(r.status).toBe(404);
    expect(pushVisitToGoogle).not.toHaveBeenCalled();
  });
});
