/**
 * @vitest-environment jsdom
 */
/**
 * The "Pallio does not send claims" line under each billing header (audit R35).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SUBMISSION_DISCLOSURE } from "@/lib/features/superbills/superbill-queue";

import { SubmissionDisclosure } from "../submission-disclosure";

afterEach(cleanup);

describe("SubmissionDisclosure", () => {
  it("says Pallio does not send claims, and that the figures are the team's own", () => {
    render(<SubmissionDisclosure />);
    const note = screen.getByRole("note");
    expect(note.textContent).toBe(SUBMISSION_DISCLOSURE);
    expect(note.textContent).toMatch(/does not send claims/);
    expect(note.textContent).toMatch(/what your team recorded/);
  });

  it("renders its children after the disclosure (where R10's confirmed figure goes)", () => {
    render(
      <SubmissionDisclosure>
        <strong>3 of 5 paid amounts confirmed by payer remittance.</strong>
      </SubmissionDisclosure>,
    );
    expect(screen.getByRole("note").textContent).toBe(
      `${SUBMISSION_DISCLOSURE} 3 of 5 paid amounts confirmed by payer remittance.`,
    );
    expect(screen.getByText("3 of 5 paid amounts confirmed by payer remittance.").tagName).toBe(
      "STRONG",
    );
  });

  it("keeps the icon out of the accessible text", () => {
    const { container } = render(<SubmissionDisclosure />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the caller's class", () => {
    render(<SubmissionDisclosure className="mb-4" />);
    expect(screen.getByRole("note").className).toContain("mb-4");
  });
});
