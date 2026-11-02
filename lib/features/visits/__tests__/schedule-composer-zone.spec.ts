/**
 * @vitest-environment jsdom
 */
/**
 * The booking form reads a time on the practice's clock, wherever the person
 * typing is. The practice here is in Honolulu, far from wherever this test runs,
 * so a form that read the browser's zone would post a different instant. That
 * was the bug: 10:00 typed in Karachi booked 01:00 in New York.
 *
 * The page's real form is rendered, as schedule-composer-visit-type.spec does.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children),
}));
vi.mock("@/lib/features/schedule/use-practice-zone", () => ({
  usePracticeZone: () => ({ timeZone: "Pacific/Honolulu", today: "2029-11-30", zoneName: "HST", differs: true }),
}));

import { NewVisitComposer } from "@/components/visits/new-visit-composer";

const PATIENT = "f0000000-0000-4000-8000-000000000001";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let posted: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  posted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = { success: false, error: "Not stubbed." };
      let status = 200;
      if (url === "/api/team/members?active=1") body = { success: true, data: { rows: [{ userId: ME, email: "a@b.test", fullName: "Priya Raman" }] } };
      else if (url === "/api/settings/visit-types") body = { success: true, data: { types: [{ slug: "established_patient_home", label: "Established", codingBasis: "established_patient_home" }] } };
      else if (url === "/api/visits" && init?.method === "POST") {
        posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        body = { success: true, data: { id: "e0" } };
        status = 201;
      } else if (url === "/api/visits/series" && init?.method === "POST") {
        posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        body = { success: true, data: { booked: [{ id: "e1", start: "2029-12-01T20:00:00Z" }, { id: "e2", start: "2029-12-08T20:00:00Z" }], conflicts: [] } };
        status = 201;
      }
      return Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(body) } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(onCreated = vi.fn()) {
  render(createElement(NewVisitComposer, { lockedPatient: { id: PATIENT, name: "Test Patient" }, onCreated, onCancel: vi.fn() }));
  const type = (await screen.findByLabelText(/Visit type/)) as HTMLSelectElement;
  await waitFor(() => expect(type.options.length).toBeGreaterThan(1));
  const clinician = screen.getByLabelText(/Clinician/) as HTMLSelectElement;
  await waitFor(() => expect(clinician.value).toBe(ME));
  fireEvent.change(type, { target: { value: "established_patient_home" } });
  fireEvent.change(screen.getByLabelText(/Scheduled start/), { target: { value: "2029-12-01T10:00" } });
  return onCreated;
}

const button = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("the time typed", () => {
  it("is the practice's: 10:00 in Honolulu is 20:00 UTC, whatever zone this runs in", async () => {
    await open();
    fireEvent.click(button(/Schedule visit/));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body.scheduledStart).toBe("2029-12-01T20:00:00.000Z");
  });

  it("says which clock it is on when this computer is on another", async () => {
    await open();
    expect(screen.getByLabelText(/Scheduled start \(HST\)/)).toBeTruthy();
    expect(screen.getByText(/On the practice’s clock \(Pacific\/Honolulu\)/)).toBeTruthy();
  });
});

describe("a repeating visit", () => {
  it("previews what the server will book, and the button says how many", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/Repeats/), { target: { value: "1w" } });
    fireEvent.change(screen.getByLabelText(/Number of visits/), { target: { value: "3" } });
    expect(screen.getByText(/3 visits, Sat, Dec 1 to Sat, Dec 15/)).toBeTruthy();
    expect(button(/Schedule 3 visits/).disabled).toBe(false);
  });

  it("sends the time as the practice's wall clock, for the server to place each occurrence", async () => {
    const created = await open();
    fireEvent.change(screen.getByLabelText(/Repeats/), { target: { value: "2w" } });
    fireEvent.change(screen.getByLabelText(/Number of visits/), { target: { value: "2" } });
    fireEvent.click(button(/Schedule 2 visits/));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ url: "/api/visits/series", body: { startLocal: "2029-12-01T10:00", every: 2, unit: "week", count: 2 } });
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(created.mock.calls[0]![1]).toMatchObject({ visits: 2 });
  });

  it("CONTROL: a last day before the second visit cannot be sent", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/Repeats/), { target: { value: "1w" } });
    fireEvent.change(screen.getByLabelText(/^Ends/), { target: { value: "until" } });
    fireEvent.change(screen.getByLabelText(/Last day/), { target: { value: "2029-12-03" } });
    expect(screen.getByText(/at least two visits/)).toBeTruthy();
    expect(button(/Schedule visit/).disabled).toBe(true);
  });
});
