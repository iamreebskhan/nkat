/**
 * @vitest-environment jsdom
 */
/**
 * The eye on a password field: Caps Lock cost five refused sign-ins and the lock
 * that follows them, with nothing on screen to show why.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PasswordInput } from "../password-input";

afterEach(cleanup);

const field = (container: HTMLElement) => container.querySelector("input")!;

describe("PasswordInput", () => {
  it("starts as dots, and the eye shows and hides what was typed", () => {
    const { container } = render(<PasswordInput defaultValue="Secret" />);
    expect(field(container).type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(field(container).type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(field(container).type).toBe("password");
    expect(screen.getByRole("button", { name: "Show password" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("CONTROL: pressing the eye does not send the form", () => {
    const sent = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={sent}>
        <PasswordInput defaultValue="Secret" />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(sent).not.toHaveBeenCalled();
  });

  it("goes back to dots when the form is sent", () => {
    const { container } = render(
      <form onSubmit={(e) => e.preventDefault()}>
        <PasswordInput defaultValue="Secret" />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    fireEvent.submit(container.querySelector("form")!);
    expect(field(container).type).toBe("password");
  });

  it("shows dots and no eye while read-only, the password waiting behind login's code step", () => {
    const { container, rerender } = render(<PasswordInput defaultValue="Secret" readOnly={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(field(container).type).toBe("text");

    rerender(<PasswordInput defaultValue="Secret" readOnly />);
    expect(field(container).type).toBe("password");
    expect(field(container).readOnly).toBe(true);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is still the field it replaced: value, attributes and typing all pass through", () => {
    const onChange = vi.fn();
    const { container } = render(
      <PasswordInput
        id="password"
        name="password"
        autoComplete="current-password"
        required
        minLength={12}
        value="Secret"
        onChange={onChange}
        className="w-full px-3"
      />,
    );
    const input = field(container);
    expect(input.id).toBe("password");
    expect(input.name).toBe("password");
    expect(input.autocomplete).toBe("current-password");
    expect(input.required).toBe(true);
    expect(input.minLength).toBe(12);
    expect(input.value).toBe("Secret");
    // Room for the eye, on top of the field's own look.
    expect(input.className).toBe("w-full px-3 pr-10");
    fireEvent.change(input, { target: { value: "Secret2" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
