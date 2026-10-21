/**
 * @vitest-environment jsdom
 */
/**
 * The visit's diagnosis picker (audit R13).
 *
 * The document screen had no diagnosis input, so every bill inherited the
 * patient's intake diagnosis or carried none. These tests hold the picker to
 * the two things that matter: the intake diagnosis is OFFERED, never applied
 * silently, and what the clinician picks is exactly what the visit records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";

import { DiagnosisPicker } from "../diagnosis-picker";

const LUNG = { code: "C34.12", description: "Malignant neoplasm of upper lobe, left bronchus or lung" };
const LUNG_NOS = { code: "C34.90", description: "Malignant neoplasm of unspecified part of bronchus or lung" };

let requested: string[];
let respond: (url: string) => unknown;

beforeEach(() => {
  requested = [];
  respond = () => ({ success: true, data: { rows: [LUNG, LUNG_NOS] } });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      requested.push(url);
      return Promise.resolve({ json: () => Promise.resolve(respond(url)) } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Owns the value, as the document page does. */
function Host({
  initial = [],
  intake = null,
  readOnly = false,
  spy,
}: {
  initial?: string[];
  intake?: string | null;
  readOnly?: boolean;
  spy?: (v: string[]) => void;
}) {
  const [v, setV] = useState<string[]>(initial);
  return (
    <DiagnosisPicker
      value={v}
      onChange={(n) => {
        setV(n);
        spy?.(n);
      }}
      intakeDiagnosis={intake}
      readOnly={readOnly}
    />
  );
}

const search = () => screen.getByLabelText("Search diagnoses (ICD-10)");

describe("DiagnosisPicker", () => {
  it("says a diagnosis is required when none is chosen", () => {
    render(<Host />);
    expect(screen.getByText(/Required to sign/)).toBeTruthy();
  });

  // This picker renders on a "Not billed" visit too, which drafts no bill —
  // the card above it says so, and so does the sign-off refusal. Justifying
  // the requirement by the claim put a false sentence in front of a clinician
  // on exactly the visit type that never produces one.
  it("does not justify the requirement by a bill the visit may never draft", () => {
    render(<Host />);
    const line = screen.getByText(/Required to sign/).textContent ?? "";
    expect(line).toMatch(/say what it was for/i);
    expect(line).not.toMatch(/bill/i);
  });

  it("offers the intake diagnosis but never applies it on its own", () => {
    const spy = vi.fn();
    render(<Host intake="C34.12" spy={spy} />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Diagnoses on this visit")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use intake diagnosis C34.12" }));
    expect(spy).toHaveBeenLastCalledWith(["C34.12"]);
    const chosen = screen.getByLabelText("Diagnoses on this visit");
    expect(within(chosen).getByText("C34.12")).toBeTruthy();
    expect(within(chosen).getByText("primary")).toBeTruthy();
  });

  it("searches ICD-10 and adds the match the clinician picks", async () => {
    const spy = vi.fn();
    render(<Host spy={spy} />);
    fireEvent.change(search(), { target: { value: "C34" } });

    const list = await screen.findByLabelText("Diagnosis matches");
    expect(requested).toContain("/api/billing/icd10?query=C34&limit=8");
    fireEvent.click(within(list).getByRole("button", { name: /C34\.12/ }));

    expect(spy).toHaveBeenLastCalledWith(["C34.12"]);
    expect((search() as HTMLInputElement).value).toBe("");
    expect(within(screen.getByLabelText("Diagnoses on this visit")).getByText(LUNG.description)).toBeTruthy();
  });

  it("does not search on a single character", async () => {
    render(<Host />);
    fireEvent.change(search(), { target: { value: "C" } });
    await new Promise((r) => setTimeout(r, 400));
    expect(requested).toHaveLength(0);
  });

  it("hides codes already on the visit from the results", async () => {
    render(<Host initial={["C34.12"]} />);
    fireEvent.change(search(), { target: { value: "C34" } });
    const list = await screen.findByLabelText("Diagnosis matches");
    expect(within(list).queryByRole("button", { name: /C34\.12/ })).toBeNull();
    expect(within(list).getByRole("button", { name: /C34\.90/ })).toBeTruthy();
  });

  it("makes another code primary by moving it first", () => {
    const spy = vi.fn();
    render(<Host initial={["C34.12", "R06.02"]} spy={spy} />);
    fireEvent.click(screen.getByRole("button", { name: "Make R06.02 the primary diagnosis" }));
    expect(spy).toHaveBeenLastCalledWith(["R06.02", "C34.12"]);
  });

  it("removes a code, and says one is required again when none remain", () => {
    const spy = vi.fn();
    render(<Host initial={["C34.12"]} spy={spy} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove C34.12" }));
    expect(spy).toHaveBeenLastCalledWith([]);
    expect(screen.getByText(/Required to sign/)).toBeTruthy();
  });

  it("offers no controls on a signed, read-only visit", () => {
    render(<Host initial={["C34.12"]} intake="C34.12" readOnly />);
    expect(screen.queryByLabelText("Search diagnoses (ICD-10)")).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Use intake/ })).toBeNull();
    expect(screen.getByText("C34.12")).toBeTruthy();
  });

  it("surfaces a failed search rather than showing no results", async () => {
    respond = () => ({ success: false, error: "Permission denied." });
    render(<Host />);
    fireEvent.change(search(), { target: { value: "C34" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Permission denied."));
  });
});
