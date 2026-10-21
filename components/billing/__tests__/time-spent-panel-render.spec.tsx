/**
 * @vitest-environment jsdom
 */
/**
 * The Time spent panel as rendered: the suggestion meets the code's minimum
 * time, says so below 20 minutes, and prints no CPT descriptor text.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { TimeSpentPanel } from "../time-spent-panel";

afterEach(cleanup);

const noop = () => {};

describe("TimeSpentPanel (rendered)", () => {
  it("suggests the code whose threshold the minutes meet", () => {
    render(<TimeSpentPanel minutes={25} onChange={noop} />);
    const line = screen.getByText(/Suggested code:/).textContent ?? "";
    expect(line).toContain("99347");
    expect(line).toContain("20–29 min");
    expect(line).not.toContain("99348");
  });

  it("says no time-based code applies under 20 minutes", () => {
    render(<TimeSpentPanel minutes={12} onChange={noop} />);
    expect(screen.getByText(/Under 20 minutes/)).toBeTruthy();
    expect(screen.queryByText(/Suggested code:/)).toBeNull();
  });

  it("prompts for minutes when none are entered", () => {
    render(<TimeSpentPanel minutes={0} onChange={noop} />);
    expect(screen.getByText(/Enter visit minutes/)).toBeTruthy();
  });

  it("prints the code and range, never CPT descriptor text", () => {
    const { container } = render(<TimeSpentPanel minutes={45} onChange={noop} />);
    expect(container.textContent).toContain("99349");
    expect(container.textContent).not.toMatch(/Home visit/);
  });

  it("marks a suggestion already on the bill", () => {
    render(<TimeSpentPanel minutes={45} onChange={noop} selectedCodes={["99349"]} onUseSuggestion={noop} />);
    expect(screen.getByText(/already added/)).toBeTruthy();
    expect(screen.queryByText(/Use this code/)).toBeNull();
  });
});

/**
 * The bill page now passes the visit's ACP minutes and the ladder for its own
 * band. Before, on localhost, a new-patient visit of 45 minutes with 20 of ACP
 * (signed 99342 + 99497) was offered 99349 — the established ladder, on the
 * whole 45 minutes — and "Use this code" put it on the bill beside 99342.
 */
describe("TimeSpentPanel — the visit's own ladder and ACP minutes", () => {
  /** The new-patient ladder as /api/billing/code-bands builds it from code.typical_minutes. */
  const NEW_PATIENT = [
    { min: 15, max: 29, code: "99341" },
    { min: 30, max: 59, code: "99342" },
    { min: 60, max: 74, code: "99344" },
    { min: 75, max: Number.POSITIVE_INFINITY, code: "99345" },
  ];
  const line = () => screen.getByText(/Suggested code:/).textContent ?? "";

  it("codes 45 minutes with 20 of ACP on the 25 E/M minutes, on the new-patient ladder", () => {
    render(<TimeSpentPanel minutes={45} acpMinutes={20} brackets={NEW_PATIENT} onChange={noop} />);
    expect(line()).toContain("99341");
    expect(line()).not.toContain("99349");
    expect(line()).toContain("Counted on 25 of the 45 minutes: the 20 ACP minutes bill as 99497/99498.");
  });

  it("CONTROL: the same 45 minutes with no ACP are 99342, and say nothing about ACP", () => {
    render(<TimeSpentPanel minutes={45} brackets={NEW_PATIENT} onChange={noop} />);
    expect(line()).toContain("99342");
    expect(line()).not.toContain("Counted on");
  });

  it("CONTROL: under 16 ACP minutes nothing bills as ACP, so the time stays E/M time", () => {
    render(<TimeSpentPanel minutes={45} acpMinutes={15} onChange={noop} />);
    expect(line()).toContain("99349");
    expect(line()).not.toContain("Counted on");
  });

  it("says when the ACP minutes leave too little E/M time for any code", () => {
    render(<TimeSpentPanel minutes={30} acpMinutes={20} onChange={noop} />);
    expect(screen.getByText(/Under 20 minutes of E\/M time/)).toBeTruthy();
    expect(screen.getByText(/Counted on 10 of the 30 minutes/)).toBeTruthy();
    expect(screen.queryByText(/Suggested code:/)).toBeNull();
  });

  it("says when fewer minutes are typed than the visit's ACP minutes", () => {
    render(<TimeSpentPanel minutes={15} acpMinutes={20} onChange={noop} />);
    expect(screen.getByText(/Fewer minutes than the visit’s 20 ACP minutes/)).toBeTruthy();
    expect(screen.queryByText(/Suggested code:/)).toBeNull();
  });

  it("suggests nothing for a band with no home-visit ladder, and lists no ladder", () => {
    const { container } = render(<TimeSpentPanel minutes={45} brackets={[]} onChange={noop} />);
    expect(screen.getByText(/No time-based home visit code applies to this visit’s type/)).toBeTruthy();
    expect(container.querySelector("ul")).toBeNull();
  });

  it("lists the ladder it was given", () => {
    const { container } = render(<TimeSpentPanel minutes={0} brackets={NEW_PATIENT} onChange={noop} />);
    expect(container.querySelector("ul")?.textContent).toContain("15–29 min → 99341");
    expect(container.querySelector("ul")?.textContent).toContain("75+ min → 99345");
    expect(container.querySelector("ul")?.textContent).not.toContain("99347");
  });

  it("offers no live Use this code on a bill that can no longer be edited", () => {
    render(<TimeSpentPanel minutes={45} disabled onChange={noop} onUseSuggestion={noop} />);
    expect((screen.getByRole("button", { name: /Use this code/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
