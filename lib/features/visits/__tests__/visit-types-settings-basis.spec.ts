/**
 * @vitest-environment jsdom
 */
/**
 * /settings/visit-types — a new visit type bills like what someone chose.
 *
 * The create form started "Bills like" on established_patient_home, with no
 * empty option, and Add checked only the name. Typing a name and pressing Add
 * posted that band without anyone choosing it, and the band decides which CPT
 * ladder every visit of the type is coded on. The server has no default of its
 * own (visit-types.service.ts takes codingBasis as a required enum), so the
 * page's pre-fill was the only silent choice. The schedule composer already
 * works this way: nothing is chosen for the user
 * (schedule-composer-visit-type.spec.ts).
 *
 * The same select sat inside a <label> after the InfoTip's <button>, so the
 * label's control was the button and the select had no accessible name.
 *
 * The shipped page is rendered, not read as text. Plain createElement rather
 * than JSX: lib specs are .ts.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

import VisitTypesSettingsPage from "@/app/(platform)/settings/visit-types/page";

/** The four seeded types as the local database holds them, then one custom type. */
const TYPES = [
  {
    id: "70000000-0000-4000-8000-000000000001", slug: "new_patient_home", label: "New patient — home",
    codingBasis: "new_patient_home", isTelehealth: false, active: true, builtIn: true, usageCount: 0,
  },
  {
    id: "70000000-0000-4000-8000-000000000002", slug: "established_patient_home", label: "Established patient — home",
    codingBasis: "established_patient_home", isTelehealth: false, active: true, builtIn: true, usageCount: 0,
  },
  {
    id: "70000000-0000-4000-8000-000000000003", slug: "advance_care_planning", label: "Advance care planning",
    codingBasis: "advance_care_planning", isTelehealth: false, active: true, builtIn: true, usageCount: 0,
  },
  {
    id: "70000000-0000-4000-8000-000000000004", slug: "telehealth", label: "Established patient — telehealth",
    codingBasis: "established_patient_home", isTelehealth: true, active: true, builtIn: true, usageCount: 0,
  },
  {
    id: "70000000-0000-4000-8000-00000000000c", slug: "assisted_living_follow_up", label: "Follow-up — assisted living",
    codingBasis: "new_patient_home", isTelehealth: false, active: true, builtIn: false, usageCount: 0,
  },
];

let posted: Record<string, unknown>[];

beforeEach(() => {
  posted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = { success: false, error: "Not stubbed." };
      let status = 200;
      if (url === "/api/settings/visit-types?includeInactive=1" && !init) {
        body = { success: true, data: { types: TYPES } };
      } else if (url === "/api/settings/visit-types" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        body = { success: true, data: { id: "70000000-0000-4000-8000-00000000000d", slug: "hospice_aide_check_in" } };
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

/** The page with its list loaded, and the three controls of the Add form. */
async function openPage() {
  render(createElement(VisitTypesSettingsPage));
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  return {
    name: screen.getByLabelText(/^Name/) as HTMLInputElement,
    // By label text and tag, which finds the select before and after the
    // label is pointed at it (testing-library takes the label's first
    // descendant that matches the selector).
    basis: screen.getByLabelText(/Bills like/, { selector: "select" }) as HTMLSelectElement,
    add: screen.getByRole("button", { name: "Add visit type" }) as HTMLButtonElement,
  };
}

describe("Add a visit type — what it bills like", () => {
  it("starts with nothing chosen, and a name alone does not turn Add on", async () => {
    const { name, basis, add } = await openPage();
    fireEvent.change(name, { target: { value: "Hospice aide check-in" } });
    expect(basis.value).toBe("");
    expect(basis.required).toBe(true);
    expect(add.disabled).toBe(true);
    // Pressing it anyway (it is disabled) adds nothing.
    fireEvent.click(add);
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toEqual([]);
  });

  it("CONTROL — choosing a band turns Add on and posts exactly that band", async () => {
    const { name, basis, add } = await openPage();
    fireEvent.change(name, { target: { value: "Hospice aide check-in" } });
    fireEvent.change(basis, { target: { value: "new_patient_home" } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ label: "Hospice aide check-in", codingBasis: "new_patient_home", isTelehealth: false });
  });

  it("goes back to nothing chosen once a type is added, so the next one is chosen too", async () => {
    const { name, basis, add } = await openPage();
    fireEvent.change(name, { target: { value: "Hospice aide check-in" } });
    fireEvent.change(basis, { target: { value: "new_patient_home" } });
    fireEvent.click(add);
    await waitFor(() => expect(posted).toHaveLength(1));
    // The add has finished: the list is reloaded and the spinner is gone.
    await waitFor(() => expect(add.getAttribute("aria-busy")).toBeNull());
    expect(name.value).toBe("");
    expect(basis.value).toBe("");
    fireEvent.change(name, { target: { value: "Chaplain visit" } });
    expect(add.disabled).toBe(true);
  });

  it("names the select by its label, not by the (i) button inside that label", async () => {
    const { basis } = await openPage();
    expect(screen.getByRole("combobox", { name: /^Bills like/ })).toBe(basis);
  });

  it("CONTROL — Edit on a custom row starts from that row's own band", async () => {
    await openPage();
    const row = screen.getByText("Follow-up — assisted living").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    // Scoped to the row, so it does not lean on the Add form's select name.
    const edit = within(row).getByRole("combobox", { name: "Bills like" }) as HTMLSelectElement;
    expect(edit.value).toBe("new_patient_home");
  });
});
