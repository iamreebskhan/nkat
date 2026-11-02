/**
 * @vitest-environment jsdom
 */
/**
 * An invite whose email did not go out. The form set a notice with the link and
 * then, in the same breath, left for the invites tab, which unmounted the form
 * and the notice with it: the admin saw nothing and had no way to get the link.
 * Found by inviting an intake coordinator on a deployment with no email set up.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TeamPage from "@/app/(platform)/team/page";

const fetchMock = vi.fn();
const LINK = "http://localhost:3000/invites/a-token";

/** The invite POST answers with `invite`; every list answers empty. */
const answers = (invite: Record<string, unknown>) =>
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => ({
    status: 200,
    json: async () =>
      init?.method === "POST"
        ? { success: true, data: invite }
        : { success: true, data: { rows: url.includes("invites") ? [{ id: "i1", email: "new@example.test", roleTemplate: "clinician", permissions: ["patients.view"], createdAt: "2026-11-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z" }] : [] } },
  }));

const invite = async () => {
  render(<TeamPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Invite new member" }));
  const email = await waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("input[type=email]");
    expect(input).not.toBeNull();
    return input!;
  });
  fireEvent.change(email, { target: { value: "new@example.test" } });
  fireEvent.submit(email.closest("form")!);
  await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "POST")).toBe(true));
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Team page, inviting someone", () => {
  it("hands over the link when no email went out, and keeps it after leaving the form", async () => {
    answers({ emailDelivered: false, acceptUrl: LINK });
    await invite();
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("no email was sent to new@example.test");
    expect(notice.textContent).toContain(LINK);
    // The move to the invites tab is what used to take it away.
    expect(await screen.findByText("new@example.test")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(LINK);
  });

  it("CONTROL: says nothing when the email went out", async () => {
    answers({ emailDelivered: true, acceptUrl: LINK });
    await invite();
    await screen.findByText("new@example.test");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.body.textContent).not.toContain(LINK);
  });
});
