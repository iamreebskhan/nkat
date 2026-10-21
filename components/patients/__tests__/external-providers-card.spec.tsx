/**
 * @vitest-environment jsdom
 */
/**
 * The outside-providers card's "From your roster" search (audit R30).
 *
 * "No match on your roster" sat under the search box for about four seconds
 * on a slow first response before Dr Alan Brooks appeared: the card read the
 * empty list a search starts from as the roster's answer. These hold it to
 * "Searching…" until the answer for the text in the box lands, to ignoring an
 * answer for text that is no longer there, and (the controls) to still saying
 * "No match" once the roster really has none.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExternalProvidersCard } from "../external-providers-card";

const PATIENT = "44444444-4444-4444-8444-444444444444";
const BROOKS = {
  id: "88888888-8888-4888-8888-888888888888",
  fullName: "Dr Alan Brooks",
  npi: "1234567893",
  specialty: "Internal medicine",
  practiceName: null,
  phone: null,
  fax: null,
};
const ROSTER = "/api/external-providers?q=";
const NO_MATCH = /No match on your roster/;

/** Roster searches still in flight, by query; the test settles each one. */
let inFlight: Map<string, (body: unknown) => void>;

beforeEach(() => {
  inFlight = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith(ROSTER)) {
        const q = decodeURIComponent(url.slice(ROSTER.length));
        return new Promise((resolve) => {
          inFlight.set(q, (body) => resolve({ json: () => Promise.resolve(body) } as Response));
        });
      }
      // The patient's links: none yet, so the card offers "Add provider".
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { rows: [] } }) } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openSearch() {
  render(<ExternalProvidersCard patientId={PATIENT} canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
  return screen.getByLabelText(/Search by name, practice or NPI/);
}

/** Type, then wait out the debounce until the request for that text has gone. */
async function search(box: HTMLElement, text: string) {
  fireEvent.change(box, { target: { value: text } });
  await waitFor(() => expect(inFlight.has(text)).toBe(true));
}

/** Settle the request for `text`, and let its json() and state update run. */
async function answer(text: string, body: unknown) {
  await act(async () => {
    inFlight.get(text)!(body);
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("ExternalProvidersCard — roster search", () => {
  it("says Searching… — never 'No match' — until the roster answers", async () => {
    const box = await openSearch();
    await search(box, "Bro");
    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(screen.queryByText(NO_MATCH)).toBeNull();

    await answer("Bro", { success: true, data: { rows: [BROOKS] } });
    expect(screen.getByText("Dr Alan Brooks")).toBeTruthy();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("ignores an answer for text that is no longer in the box", async () => {
    const box = await openSearch();
    await search(box, "Bro");
    await search(box, "Nair");
    await answer("Bro", { success: true, data: { rows: [BROOKS] } });
    expect(screen.queryByText("Dr Alan Brooks")).toBeNull();
    expect(screen.getByText("Searching…")).toBeTruthy();
  });

  it("CONTROL: still says 'No match on your roster' once the roster has none, and offers a new provider", async () => {
    const box = await openSearch();
    await search(box, "Nair");
    await answer("Nair", { success: true, data: { rows: [] } });
    expect(screen.getByText(NO_MATCH)).toBeTruthy();
    expect(screen.queryByText("Searching…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add them as a new provider" }));
    expect(screen.queryByLabelText(/Search by name, practice or NPI/)).toBeNull();
  });

  it("CONTROL: one character sends no search and says nothing", async () => {
    const box = await openSearch();
    fireEvent.change(box, { target: { value: "B" } });
    // Longer than the 250 ms debounce.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(inFlight.size).toBe(0);
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.queryByText(NO_MATCH)).toBeNull();
  });

  it("a failed search says so, rather than searching for ever or claiming no match", async () => {
    const box = await openSearch();
    await search(box, "Bro");
    await answer("Bro", { success: false, error: "Internal error." });
    expect(screen.getByText(/Could not search your roster/)).toBeTruthy();
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.queryByText(NO_MATCH)).toBeNull();
  });
});
