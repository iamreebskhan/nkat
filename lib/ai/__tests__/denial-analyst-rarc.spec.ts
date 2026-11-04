/**
 * The denial analyst explains a remark code only from its wording.
 *
 * Live test 2026-10-22: handed "CARC: 16 / RARC: MA130" with no wording, the
 * analyst said MA130 "points to a missing or invalid 'Patient Reason for
 * Visit'". MA130 is the unprocessable-claim remark: no appeal rights, submit a
 * new claim. The RARC now travels with its wording when Pallio holds it, and
 * is marked as unexplained when it does not.
 *
 * The SDK is stubbed; the test reads the request the analyst would send.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));
vi.mock("@/lib/env", () => ({ env: () => ({ ANTHROPIC_API_KEY: "test-key-not-real" }) }));
vi.mock("@/lib/ai/anthropic.client", () => ({ withTransientRetry: (fn: () => unknown) => fn() }));
vi.mock("@/lib/features/billing/payer-rule.repository", () => ({ fetchPayerRule: vi.fn(async () => null) }));
vi.mock("@/lib/features/rulebook/org-rule.repository", () => ({ fetchOrgRule: vi.fn(async () => null) }));

import { fetchPayerRule } from "@/lib/features/billing/payer-rule.repository";
import { fetchOrgRule } from "@/lib/features/rulebook/org-rule.repository";

import { analyzeDenial } from "../denial-analyst";

const base = {
  cptCode: "99350",
  payerId: "a0000000-0000-4000-8000-000000000401",
  state: "OH",
  orgId: "11111111-1111-4111-8111-111111111111",
  carcCode: "16",
  denialReason: "Claim/service lacks information or has submission/billing error(s).",
  dateOfService: "2026-10-22",
};

function sent(): { system: string; user: string } {
  const req = create.mock.calls[0]![0] as { system: string; messages: { content: string }[] };
  return { system: req.system, user: req.messages[0]!.content };
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({
    content: [
      {
        type: "text",
        text: JSON.stringify({ likely_cause: "c", explanation: "e", recommendation: "refile", citation: null }),
      },
    ],
  });
});

describe("analyzeDenial — remark codes", () => {
  it("sends MA130 with its wording", async () => {
    await analyzeDenial({ ...base, rarcCode: "MA130" });
    const { user } = sent();
    expect(user).toContain("RARC: MA130 — Your claim contains incomplete and/or invalid information");
    expect(user).toContain("Submit a new claim with the complete/correct information.");
    expect(user).not.toContain("do not interpret");
  });

  it("marks a remark code it holds no wording for as unexplained", async () => {
    await analyzeDenial({ ...base, rarcCode: "N999" });
    expect(sent().user).toContain("RARC: N999 — (wording not on file; do not interpret this code)");
  });

  it("tells the model to explain a code only from the wording given", async () => {
    await analyzeDenial({ ...base, rarcCode: "MA130" });
    expect(sent().system).toContain("Explain a CARC or RARC only from the wording given with it");
  });

  it("sends the CARC with its wording, and no RARC line when there is none", async () => {
    await analyzeDenial({ ...base, rarcCode: null });
    const { user } = sent();
    expect(user).toContain("CARC: 16 — Claim/service lacks information or has submission/billing error(s).");
    expect(user).not.toContain("RARC");
  });
});

// Found 2 Nov with the live model: CareSource Ohio's rule for 99348 quotes the
// fee schedule "revised 01/01/2026", the guard read that as a birth date, and
// every analysis matched to it fell back to the heuristic.
describe("analyzeDenial — what the PHI guard reads as what", () => {
  const dated = {
    coverageStatus: "covered",
    sourceQuote: 'Per rule 5160-1-60, revised 01/01/2026, "MSRIAP schedule" tab: 99348 payable',
    effectiveDate: new Date("2024-01-01T00:00:00Z"),
  };

  it("reaches the model when the library rule quotes a dated payer document", async () => {
    vi.mocked(fetchPayerRule).mockResolvedValueOnce(dated as never);
    // With a rule given, a recommendation has to cite it to stand.
    create.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ likely_cause: "c", explanation: "e", recommendation: "refile", citation: { document_name: "Fee schedule", verbatim_quote: "99348 payable" } }) }],
    });
    const r = await analyzeDenial({ ...base, rarcCode: "MA130" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(sent().user).toContain("revised 01/01/2026");
    expect(r.aiUsed).toBe(true);
  });

  it("CONTROL: a date in the denial's own reason is still refused, and the log says why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetchPayerRule).mockResolvedValueOnce(dated as never);
    const r = await analyzeDenial({ ...base, rarcCode: null, denialReason: "Patient DOB 03/14/1949 not on file" });
    expect(create).not.toHaveBeenCalled();
    expect(r.aiUsed).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/PhiGuardError: PHI guard tripped at denialAnalyst: dob_slash/);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("03/14/1949");
    warn.mockRestore();
  });

  it("CONTROL: an SSN in a library rule's quote is still refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetchPayerRule).mockResolvedValueOnce({ ...dated, sourceQuote: "Member SSN 123-45-6789" } as never);
    const r = await analyzeDenial({ ...base, rarcCode: null });
    expect(create).not.toHaveBeenCalled();
    expect(r.aiUsed).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/denialAnalyst\.rule: ssn/);
    warn.mockRestore();
  });

  it("CONTROL: the practice's own rulebook stays on the prompt bar", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetchOrgRule).mockResolvedValueOnce({ origin: "attested", coverageStatus: "covered", sourceQuote: "Rep confirmed on 01/01/2026" } as never);
    const r = await analyzeDenial({ ...base, rarcCode: null });
    expect(create).not.toHaveBeenCalled();
    expect(r.aiUsed).toBe(false);
    warn.mockRestore();
  });
});
