/**
 * @vitest-environment jsdom
 */
/**
 * /settings/visit-services — the Add form.
 *
 * The CPT hint input sat inside a <label> after the InfoTip's <button>, so the
 * label's control was the button and the input had no label at all (on
 * localhost: `input.labels` was empty, and the label named "About the CPT
 * hint"). The visit types page had the same defect and the same fix.
 *
 * "Add service" passes disabled={name.trim().length < 2} with loading={adding}.
 * The Button resolved that as `disabled ?? loading`, so with a valid name the
 * caller's `false` won: the button stayed enabled while the POST was in
 * flight, and a second click sent a second one (seen on localhost, with the
 * POST held open: aria-busy true, disabled false, two requests).
 *
 * The shipped page is rendered. Plain createElement rather than JSX: lib specs
 * are .ts.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import VisitServicesSettingsPage from "@/app/(platform)/settings/visit-services/page";

let posts: Record<string, unknown>[];
/** Resolves the POST held open, when a case holds it. */
let releasePost: (() => void) | null;

beforeEach(() => {
  posts = [];
  releasePost = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const respond = (body: unknown, status = 200) =>
        ({ status, ok: status < 400, json: () => Promise.resolve(body) }) as Response;
      if (url === "/api/settings/visit-services?includeInactive=1" && !init) {
        return Promise.resolve(respond({ success: true, data: { services: [] } }));
      }
      if (url === "/api/settings/visit-services" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        // Held open until the case releases it, as a slow network holds it.
        return new Promise<Response>((resolve) => {
          releasePost = () =>
            resolve(respond({ success: true, data: { id: "71000000-0000-4000-8000-000000000001" } }, 201));
        });
      }
      return Promise.resolve(respond({ success: false, error: "Not stubbed." }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openPage() {
  render(createElement(VisitServicesSettingsPage));
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
}

describe("/settings/visit-services — the Add form", () => {
  it("names the CPT hint input by its own label", async () => {
    await openPage();
    const hint = screen.getByPlaceholderText("99497");
    // Its accessible name, as a screen reader computes it. With no label the
    // name fell back to the placeholder, "99497".
    expect(screen.getByRole("textbox", { name: /^CPT hint/ })).toBe(hint);
    expect((hint as HTMLInputElement).labels?.length).toBe(1);
  });

  it("CONTROL: the ⓘ beside it is still its own button, named for what it explains", async () => {
    await openPage();
    expect(screen.getByRole("button", { name: "About the CPT hint" })).toBeTruthy();
  });

  it("sends one request however often Add is clicked while it is saving", async () => {
    await openPage();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Bereavement support" } });
    const add = screen.getByRole("button", { name: "Add service" }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);

    fireEvent.click(add);
    await waitFor(() => expect(posts).toHaveLength(1));
    // Saving: disabled as well as busy, so the second click goes nowhere.
    expect(add.getAttribute("aria-busy")).toBe("true");
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(posts).toHaveLength(1);

    await act(async () => releasePost?.());
    await waitFor(() => expect(add.getAttribute("aria-busy")).toBeNull());
    expect(posts).toHaveLength(1);
  });
});
