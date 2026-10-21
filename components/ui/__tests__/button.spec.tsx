/**
 * @vitest-environment jsdom
 */
/**
 * A loading Button takes no clicks, whatever `disabled` the caller passes.
 *
 * It resolved `disabled ?? loading`, so a caller's disabled={false} won over
 * loading — and callers pass exactly that whenever their own guard is
 * satisfied, e.g. disabled={name.trim().length < 2} on "Add service". The
 * button stayed enabled mid-request and a second click sent the request again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Button } from "../button";

afterEach(cleanup);

describe("Button — loading", () => {
  it("is disabled while loading even when the caller passes disabled={false}", () => {
    const onClick = vi.fn();
    render(
      <Button loading disabled={false} onClick={onClick}>
        Add service
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Add service" }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is disabled while loading when the caller passes nothing", () => {
    render(<Button loading>Save</Button>);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("CONTROL: not loading, it follows the caller's disabled either way", () => {
    const onClick = vi.fn();
    render(
      <>
        <Button disabled={false} onClick={onClick}>
          Go
        </Button>
        <Button disabled>Stop</Button>
      </>,
    );
    const go = screen.getByRole("button", { name: "Go" }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    expect(go.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(go);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
