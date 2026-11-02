/**
 * @vitest-environment jsdom
 */
/**
 * The session refresh telling a page already open that a second factor is now
 * owed. Found by signing in as a clinician and changing the practice's rule
 * under them: the API refused them, as it should, but MfaGate sits in a layout
 * that does not re-render on an in-app navigation, so they were left on a page
 * of refusals reading "No visits assigned".
 *
 * It asks rather than sends: a note section saves when the cursor leaves it, so
 * a page load would take whatever was being typed without a word.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdleGuard } from "../idle-guard";

const place = { href: "", pathname: "/visits" };
const fetchMock = vi.fn();
const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  place.href = "";
  place.pathname = "/visits";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", place);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const refreshAnswers = (mfaPending: boolean) =>
  fetchMock.mockResolvedValue({
    status: 200,
    json: async () => ({ success: true, data: { act: nowSec(), idleMinutes: 30, mfaPending } }),
  });

const click = () =>
  act(async () => {
    fireEvent.pointerDown(window);
  });

/** A session last used two minutes ago, so the next input reports at once. */
const mountAndClick = async () => {
  render(<IdleGuard idleMinutes={30} act={nowSec() - 120} />);
  await click();
};

describe("IdleGuard and a second factor the practice starts requiring", () => {
  it("asks the person to set it up when the refresh says it is owed, and leaves the page where it is", async () => {
    refreshAnswers(true);
    await mountAndClick();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/activity", expect.objectContaining({ method: "POST" }));
    expect(screen.getByRole("alertdialog").textContent).toMatch(/copy it first/);
    expect(place.href).toBe("");
  });

  it("goes to the setup page only when they say so", async () => {
    refreshAnswers(true);
    await mountAndClick();
    fireEvent.click(screen.getByRole("button", { name: "Set it up now" }));
    expect(place.href).toBe("/settings/security?required=1");
  });

  it("gives the focus to staying, so a keystroke meant for the note cannot leave the page", async () => {
    refreshAnswers(true);
    await mountAndClick();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stay on this page" }));
  });

  it("lets them stay to copy what they typed, and asks again at the next report", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    refreshAnswers(true);
    await mountAndClick();
    fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(place.href).toBe("");

    // Within the minute nothing is reported, so nothing is asked.
    await click();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    vi.setSystemTime(Date.now() + 61_000);
    await click();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("a press on Stay counts as input, so the report it sets off must not reopen the question", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    refreshAnswers(true);
    await mountAndClick();
    vi.setSystemTime(Date.now() + 61_000);

    // The answer arrives after the click, as it does on any real connection.
    let answer!: (r: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const stay = screen.getByRole("button", { name: "Stay on this page" });
    await act(async () => {
      fireEvent.pointerDown(stay);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 100);
    fireEvent.click(stay);
    await act(async () => {
      answer({
        status: 200,
        json: async () => ({ success: true, data: { act: nowSec(), idleMinutes: 30, mfaPending: true } }),
      });
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // The next report asks again.
    vi.setSystemTime(Date.now() + 61_000);
    await click();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("stops asking if the practice takes the rule back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    refreshAnswers(true);
    await mountAndClick();
    refreshAnswers(false);
    vi.setSystemTime(Date.now() + 61_000);
    await click();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("CONTROL: says nothing when nothing is owed", async () => {
    refreshAnswers(false);
    await mountAndClick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("CONTROL: says nothing on the setup page itself, where the person is already doing it", async () => {
    place.pathname = "/settings/security";
    refreshAnswers(true);
    await mountAndClick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("CONTROL: a session past its limit still signs out, rather than asking anything", async () => {
    fetchMock.mockResolvedValue({ status: 401, json: async () => ({ success: false }) });
    await mountAndClick();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(place.href).toBe("/login?reason=idle");
  });
});
