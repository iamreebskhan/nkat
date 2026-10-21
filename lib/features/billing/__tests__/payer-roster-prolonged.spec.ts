/**
 * @vitest-environment jsdom
 */
/**
 * The payer roster screen sets the prolonged-service code a payer takes (0108).
 *
 * The roster shows which code each payer gets and whether that is its own
 * setting or its type's default, and the edit form sends the code only when it
 * changed, so the audit row names what was edited. The shipped page is
 * rendered against a stubbed /api/admin/payers and driven by its own controls.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children),
}));

import PayerRosterPage from "@/app/(platform)/admin/payers/page";

const MCO = "c0000000-0000-4000-8000-0000000000a1";
const SET = "c0000000-0000-4000-8000-0000000000a2";
const MEDICARE = "c0000000-0000-4000-8000-0000000000a3";

const row = (id: string, name: string, payerType: string, prolongedServiceCode: string | null) => ({
  id, name, parentOrg: null, payerType, statesServed: ["OH"], policyIndexUrl: null,
  prolongedServiceCode, active: true, liveRules: { OH: 3 },
});

let patches: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  patches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = { success: false, data: null, error: "Not stubbed." };
      if (url === "/api/admin/payers" && !init?.method) {
        body = {
          success: true,
          data: {
            rows: [
              row(MCO, "CareSource Ohio", "medicaid_mco", null),
              row(SET, "Buckeye Health Plan", "medicaid_mco", "G0318"),
              row(MEDICARE, "Traditional Medicare (Part B)", "medicare_mac", null),
            ],
          },
        };
      } else if (url.startsWith("/api/admin/payers/") && init?.method === "PATCH") {
        patches.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        body = { success: true, data: { name: "CareSource Ohio" } };
      }
      return Promise.resolve({ status: 200, json: () => Promise.resolve(body) } as Response);
    }),
  );
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openRoster() {
  await act(async () => {
    render(createElement(PayerRosterPage));
  });
  await screen.findByText("CareSource Ohio");
}

const rowOf = (name: string) => screen.getByText(name).closest("tr")!;

describe("payer roster — the prolonged-service code (0108)", () => {
  it("shows each payer's code, and whether it is the payer's own or its type's", async () => {
    await openRoster();
    expect(within(rowOf("CareSource Ohio")).getByText(/Prolonged: 99417 \(by type\)/)).toBeTruthy();
    expect(within(rowOf("Buckeye Health Plan")).getByText(/Prolonged: G0318 \(set for this payer\)/)).toBeTruthy();
    expect(within(rowOf("Traditional Medicare (Part B)")).getByText(/Prolonged: G0318 \(by type\)/)).toBeTruthy();
  });

  it("sets a payer's code, sending that field alone", async () => {
    await openRoster();
    fireEvent.click(within(rowOf("CareSource Ohio")).getByRole("button", { name: "Edit" }));
    const select = (await screen.findByRole("combobox", { name: /Prolonged-service code/ })) as HTMLSelectElement;
    // The default option names the code the payer's type gives it.
    expect(select.value).toBe("");
    expect(within(select).getByRole("option", { name: "By payer type (99417)" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "G0318" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ url: `/api/admin/payers/${MCO}`, body: { prolongedServiceCode: "G0318" } });
  });

  it("clears a payer's own code back to its type's, sending null", async () => {
    await openRoster();
    fireEvent.click(within(rowOf("Buckeye Health Plan")).getByRole("button", { name: "Edit" }));
    const select = (await screen.findByRole("combobox", { name: /Prolonged-service code/ })) as HTMLSelectElement;
    expect(select.value).toBe("G0318");
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.body).toEqual({ prolongedServiceCode: null });
  });

  it("CONTROL: an edit that leaves the code alone does not send it", async () => {
    await openRoster();
    fireEvent.click(within(rowOf("CareSource Ohio")).getByRole("button", { name: "Edit" }));
    const name = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "CareSource Ohio Inc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.body).toEqual({ name: "CareSource Ohio Inc" });
  });
});
