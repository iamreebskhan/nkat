/**
 * @vitest-environment jsdom
 */
/**
 * The units editor on the bill page, as rendered. A biller can correct the
 * count on a per-increment add-on (G0318, 99417, 99498) and nothing else: a
 * home E/M is reported once per date of service, so 99350 gets no input at
 * all rather than one the server would refuse.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CodeUnitsEditor } from "../code-units-editor";

afterEach(cleanup);

const input = (code: string) => screen.getByLabelText(`${code} units`) as HTMLInputElement;

describe("CodeUnitsEditor (rendered)", () => {
  it("gives G0318 an input and 99350 none", () => {
    render(<CodeUnitsEditor codes={["99350", "G0318"]} units={{}} onChange={() => {}} />);
    expect(input("G0318").value).toBe("1");
    expect(screen.queryByLabelText("99350 units")).toBeNull();
  });

  it("reports a typed count as the whole units map, and 1 as no key", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CodeUnitsEditor codes={["99350", "G0318"]} units={{}} onChange={onChange} />,
    );
    fireEvent.change(input("G0318"), { target: { value: "3" } });
    expect(onChange).toHaveBeenLastCalledWith({ G0318: 3 });

    rerender(<CodeUnitsEditor codes={["99350", "G0318"]} units={{ G0318: 3 }} onChange={onChange} />);
    expect(input("G0318").value).toBe("3");
    fireEvent.change(input("G0318"), { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("does not report a count outside 1–99", () => {
    const onChange = vi.fn();
    render(<CodeUnitsEditor codes={["G0318"]} units={{}} onChange={onChange} />);
    fireEvent.change(input("G0318"), { target: { value: "150" } });
    fireEvent.change(input("G0318"), { target: { value: "0" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("bounds the input 1 to 99, the range the server and the column accept", () => {
    render(<CodeUnitsEditor codes={["G0318"]} units={{}} onChange={() => {}} />);
    expect(input("G0318").min).toBe("1");
    expect(input("G0318").max).toBe("99");
  });

  it("shows the cap warning inline at 5 units of G0318, and not at 4", () => {
    const { rerender, container } = render(
      <CodeUnitsEditor codes={["99350", "G0318"]} units={{ G0318: 5 }} onChange={() => {}} />,
    );
    expect(container.textContent).toContain("Pallio allows");
    rerender(<CodeUnitsEditor codes={["99350", "G0318"]} units={{ G0318: 4 }} onChange={() => {}} />);
    expect(container.textContent).not.toContain("Pallio allows");
  });

  it("is read-only when the bill is not editable", () => {
    render(<CodeUnitsEditor codes={["G0318"]} units={{ G0318: 2 }} onChange={() => {}} disabled />);
    expect(input("G0318").disabled).toBe(true);
  });

  it("shows nothing for a units key whose code is not on the bill", () => {
    const { container } = render(
      <CodeUnitsEditor codes={["99350"]} units={{ G0318: 5 }} onChange={() => {}} />,
    );
    expect(screen.queryByLabelText("G0318 units")).toBeNull();
    expect(container.textContent).not.toContain("G0318");
  });
});
