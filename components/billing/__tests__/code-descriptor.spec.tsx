/**
 * @vitest-environment jsdom
 */
/**
 * A withheld CPT descriptor, said plainly (audit R21).
 *
 * The server hands back AMA_PLACEHOLDER for CPT text on an unlicensed
 * deployment. The screen must say what that means, one gesture away, and
 * must not send an org admin to a Settings control that does not exist.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AMA_PLACEHOLDER } from "@/lib/features/billing/code-pure";

import { AMA_DESCRIPTOR_NOTE, CodeDescriptor } from "../code-descriptor";

afterEach(cleanup);

describe("CodeDescriptor", () => {
  it("says why a withheld descriptor is withheld, one gesture away", () => {
    render(<CodeDescriptor text={AMA_PLACEHOLDER} />);
    expect(screen.getByText(/Descriptor licensed by the AMA/)).toBeTruthy();
    expect(screen.queryByText(AMA_PLACEHOLDER)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About AMA descriptors" }));
    expect(screen.getByRole("tooltip").textContent).toBe(AMA_DESCRIPTOR_NOTE);
  });

  it("no longer points at a Settings licence control", () => {
    render(<CodeDescriptor text={AMA_PLACEHOLDER} />);
    fireEvent.click(screen.getByRole("button", { name: "About AMA descriptors" }));
    expect(screen.getByRole("tooltip").textContent).not.toMatch(/Settings/);
  });

  it("compact: no nested button inside a button, the note on a title instead", () => {
    const { container } = render(
      <button type="button">
        <CodeDescriptor text={AMA_PLACEHOLDER} compact />
      </button>,
    );
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(screen.getByTitle(AMA_DESCRIPTOR_NOTE)).toBeTruthy();
  });

  it("renders real text verbatim, with the caller's class", () => {
    render(<CodeDescriptor text="Prolonged home E/M" className="x" />);
    expect(screen.getByText("Prolonged home E/M").className).toBe("x");
  });

  it("renders nothing for a missing descriptor", () => {
    const { container } = render(<CodeDescriptor text={null} />);
    expect(container.textContent).toBe("");
  });
});
