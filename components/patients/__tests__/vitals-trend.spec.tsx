/**
 * @vitest-environment jsdom
 */
/**
 * The vitals trend screen.
 *
 * This exists because the trend was built as an API and never given a screen —
 * which, for Mark's ask at [06:29] ("keep track of their vitals, their
 * weight"), is the same as not building it. These tests hold the screen to the
 * two things that make it a trend rather than a list: the weight change is
 * computed, and every number is shown in the units a US clinician reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { VitalsTrend } from "../vitals-trend";

const PATIENT = "f0000000-0000-4000-8000-000000000001";

const row = (o: Record<string, unknown>) => ({
  visitId: "v1", dateOfService: "2026-09-09T10:00:00.000Z", recordedAt: "2026-09-09T10:00:00.000Z",
  heightCm: null, weightKg: null, bpSystolic: null, bpDiastolic: null,
  heartRate: null, respRate: null, temperatureC: null, spo2Percent: null,
  ppsPercent: null, painScore: null, notes: null, ...o,
});

let trend: Record<string, unknown>[];
/** Visits with vitals the patient HAS — larger than `trend` when capped. */
let total: number | undefined;
let failWith: string | null;
let requested: string[];

beforeEach(() => {
  trend = [];
  total = undefined;
  failWith = null;
  requested = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    requested.push(url);
    return Promise.resolve({
      json: () =>
        Promise.resolve(
          failWith
            ? { success: false, error: failWith }
            : { success: true, data: { trend, total } },
        ),
    } as Response);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VitalsTrend", () => {
  it("reads the patient's trend endpoint", async () => {
    render(<VitalsTrend patientId={PATIENT} />);
    await waitFor(() => expect(requested).toContain(`/api/patients/${PATIENT}/vitals`));
  });

  it("says plainly when nothing has been recorded", async () => {
    render(<VitalsTrend patientId={PATIENT} />);
    expect(await screen.findByText("No vitals recorded yet.")).toBeTruthy();
  });

  it("shows weight in pounds, converted from the stored metric", async () => {
    trend = [row({ weightKg: 68.27 })];
    render(<VitalsTrend patientId={PATIENT} />);
    expect(await screen.findByText(/150\.5 lb/)).toBeTruthy();
  });

  it("computes the weight change since the first reading", async () => {
    // The palliative signal. Newest first, as the service returns it:
    // 160 lb in June down to 128 lb now — Mark's own sample patient.
    trend = [
      row({ visitId: "v3", weightKg: 58.06, dateOfService: "2026-09-09T10:00:00.000Z", recordedAt: "2026-09-09T10:00:00.000Z" }),
      row({ visitId: "v2", weightKg: 65.77, dateOfService: "2026-07-09T10:00:00.000Z", recordedAt: "2026-07-09T10:00:00.000Z" }),
      row({ visitId: "v1", weightKg: 72.57, dateOfService: "2026-06-09T10:00:00.000Z", recordedAt: "2026-06-09T10:00:00.000Z" }),
    ];
    render(<VitalsTrend patientId={PATIENT} />);
    const down = await screen.findByText(/Down/);
    expect(down.textContent).toContain("32");
    expect(down.textContent).toContain("2026-06-09");
  });

  it("reports a gain as a gain, not an unsigned number", async () => {
    trend = [
      row({ visitId: "v2", weightKg: 72.57, dateOfService: "2026-09-09T10:00:00.000Z", recordedAt: "2026-09-09T10:00:00.000Z" }),
      row({ visitId: "v1", weightKg: 68.04, dateOfService: "2026-06-09T10:00:00.000Z", recordedAt: "2026-06-09T10:00:00.000Z" }),
    ];
    render(<VitalsTrend patientId={PATIENT} />);
    expect((await screen.findByText(/Up/)).textContent).toContain("10");
  });

  it("shows no change line when there is only one weight", async () => {
    trend = [row({ weightKg: 68.04 })];
    render(<VitalsTrend patientId={PATIENT} />);
    await screen.findByText(/150 lb/);
    expect(screen.queryByText(/Down|Up/)).toBeNull();
  });

  it("ignores visits with no weight when computing the change", async () => {
    // A visit that recorded only a pain score must not read as a weight of
    // zero and invent a catastrophic loss.
    trend = [
      row({ visitId: "v3", weightKg: 68.04, dateOfService: "2026-09-09T10:00:00.000Z", recordedAt: "2026-09-09T10:00:00.000Z" }),
      row({ visitId: "v2", painScore: 4, dateOfService: "2026-08-09T10:00:00.000Z", recordedAt: "2026-08-09T10:00:00.000Z" }),
      row({ visitId: "v1", weightKg: 72.57, dateOfService: "2026-06-09T10:00:00.000Z", recordedAt: "2026-06-09T10:00:00.000Z" }),
    ];
    render(<VitalsTrend patientId={PATIENT} />);
    const down = await screen.findByText(/Down/);
    expect(down.textContent).toContain("10");
    expect(down.textContent).toContain("2026-06-09");
  });

  it("dates a reading by the encounter, not by when it was typed up", async () => {
    // Palliative notes are written up in the evening, several visits at a
    // time. Dating the trend by recorded_at collapses months of history onto
    // whatever day the paperwork got done.
    trend = [
      row({
        visitId: "v2", weightKg: 58.06,
        dateOfService: "2026-09-09T10:00:00.000Z",
        recordedAt: "2026-09-11T22:40:00.000Z",
      }),
      row({
        visitId: "v1", weightKg: 72.57,
        dateOfService: "2026-06-09T10:00:00.000Z",
        recordedAt: "2026-09-11T22:41:00.000Z",
      }),
    ];
    render(<VitalsTrend patientId={PATIENT} />);
    const down = await screen.findByText(/Down/);
    expect(down.textContent).toContain("2026-06-09");
    expect(down.textContent).not.toContain("2026-09-11");

    const cells = screen.getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toContain("2026-09-09");
    expect(cells).not.toContain("2026-09-11");
  });

  it("renders a dash for a reading that was never taken", async () => {
    trend = [row({ weightKg: 68.04 })];
    render(<VitalsTrend patientId={PATIENT} />);
    await screen.findByText(/150 lb/);
    // Height, BP, temperature and the rest are all null on this row.
    expect(screen.getAllByText("—").length).toBeGreaterThan(3);
  });

  it("keeps a pain score of zero visible rather than dashing it", async () => {
    trend = [row({ painScore: 0 })];
    render(<VitalsTrend patientId={PATIENT} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBe(2));
    expect(screen.getAllByRole("cell").some((c) => c.textContent === "0")).toBe(true);
  });

  it("headers every column in the unit a US clinician reads", async () => {
    trend = [row({ weightKg: 68.04 })];
    render(<VitalsTrend patientId={PATIENT} />);
    const head = (await screen.findAllByRole("row"))[0]!;
    expect(head.textContent).toContain("lb");
    expect(head.textContent).toContain("°F");
    expect(head.textContent).not.toContain("kg");
    expect(head.textContent).not.toContain("°C");
  });

  it("links each reading back to the visit it came from", async () => {
    trend = [row({ visitId: "abc", weightKg: 68.04 })];
    render(<VitalsTrend patientId={PATIENT} />);
    const link = await screen.findByRole("link", { name: /Open/ });
    expect(link.getAttribute("href")).toBe("/visits/abc/document");
  });

  it("surfaces a failed read instead of rendering an empty trend", async () => {
    // An empty table and a permission error must not look the same.
    failWith = "Permission denied.";
    render(<VitalsTrend patientId={PATIENT} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Permission denied.");
  });

  it("counts the visits it is showing", async () => {
    trend = [row({ visitId: "a", weightKg: 68 }), row({ visitId: "b", weightKg: 69 })];
    render(<VitalsTrend patientId={PATIENT} />);
    expect(await screen.findByText(/2 visits with recorded vitals/)).toBeTruthy();
  });

  it("says it is showing a page, and of how many, when the history is capped", async () => {
    // The service returns newest first and caps the page, so the readings it
    // drops are the OLDEST — the baseline the weight change above is measured
    // from. Calling those 50 rows the whole record is the one thing this card
    // must not do (audit R34).
    trend = [row({ visitId: "a", weightKg: 68 }), row({ visitId: "b", weightKg: 69 })];
    total = 61;
    render(<VitalsTrend patientId={PATIENT} />);
    expect(await screen.findByText(/Latest 2 of 61 visits with recorded vitals/)).toBeTruthy();
  });

  it("does not claim to be showing a page when it is showing everything", async () => {
    // CONTROL for the line above: "Latest 2 of 2" would be its own small lie.
    trend = [row({ visitId: "a", weightKg: 68 }), row({ visitId: "b", weightKg: 69 })];
    total = 2;
    render(<VitalsTrend patientId={PATIENT} />);
    expect(await screen.findByText("2 visits with recorded vitals, newest first.")).toBeTruthy();
    // "Latest weight" is a different line and stays; "Latest 2 of 2" must not appear.
    expect(screen.queryByText(/Latest \d+ of/)).toBeNull();
  });

  it("says the weight change is measured from the page when the page is capped", async () => {
    // The change is computed from the oldest row SHOWN. On a capped chart that
    // is not the patient's first reading, so "Down 5 lb since 2026-07-09" is
    // true and still far smaller than the loss on file — the 160 lb baseline
    // sits behind the cap. The line has to say which of the two it is.
    trend = [
      row({ visitId: "b", weightKg: 58.06, dateOfService: "2026-09-09T10:00:00.000Z" }),
      row({ visitId: "a", weightKg: 60.33, dateOfService: "2026-07-09T10:00:00.000Z" }),
    ];
    total = 61;
    render(<VitalsTrend patientId={PATIENT} />);
    const down = await screen.findByText(/Down/);
    expect(down.textContent).toContain("2026-07-09");
    expect(down.textContent).toContain("not the first on file");
  });

  it("does not disclaim the weight change when nothing is behind the cap", async () => {
    // CONTROL for the line above: on a whole record the oldest row shown IS
    // the first reading, and hedging a complete figure is its own small lie.
    trend = [
      row({ visitId: "b", weightKg: 58.06, dateOfService: "2026-09-09T10:00:00.000Z" }),
      row({ visitId: "a", weightKg: 60.33, dateOfService: "2026-07-09T10:00:00.000Z" }),
    ];
    total = 2;
    render(<VitalsTrend patientId={PATIENT} />);
    const down = await screen.findByText(/Down/);
    expect(down.textContent).toContain("2026-07-09");
    expect(down.textContent).not.toContain("not the first on file");
  });
});
