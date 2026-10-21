/**
 * The printed superbill's codes row (0106).
 *
 * The bill now carries units per code, and the printed bill is what goes in
 * the audit packet and to anyone reconciling a claim: a G0318 billed three
 * times has to print as three, or the paper disagrees with the billed amount
 * beside it. The row is also escaped now. It was the one row built from
 * stored text without esc(), and codes reach it from a PATCH that checks
 * only their length.
 *
 * The real generateSuperbillPdf runs against a fake database; the browser is
 * replaced so the HTML it is handed can be read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  launch: vi.fn(),
  setContent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("puppeteer", () => ({ default: { launch: h.launch } }));
vi.mock("@/lib/hipaa/phi-access-log", () => ({
  logPhiExport: vi.fn().mockResolvedValue(undefined),
  logPhiAccess: vi.fn().mockResolvedValue(undefined),
}));

import { withOrgContext } from "@/lib/db";

import { generateSuperbillPdf } from "../superbill-pdf.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const SB = "86bc0d67-4bfa-4c69-85ac-83c1e725354c";

let bill: Record<string, unknown>;

beforeEach(() => {
  bill = {
    id: SB, visit_id: "e0000000-0000-4000-8000-00000000000c", status: "draft",
    date_of_service: new Date("2026-09-09"), cpt_codes: ["99350", "G0318"], cpt_units: { G0318: 3 },
    icd10_codes: ["C34.90"], modifiers: [], member_id_snapshot: "M1",
    provider_npi: "1234567893", provider_name: "Jane NP", billing_npi: "1497758544",
    place_of_service_code: "12", pos_description: "Home", billed_amount_cents: BigInt(22325),
    paid_amount_cents: null, payer_name: "Medicare", patient_id: "p1",
    first_name: "Leonard", last_name: "Petrakis", date_of_birth: new Date("1941-03-02"),
  };
  const run = (strings: TemplateStringsArray) => {
    const sql = strings.join("¶");
    if (sql.includes("FROM superbill s")) {
      // The bill carries its units only when the statement selects them, as
      // in Postgres. Handing them back regardless let the controls below pass
      // with s.cpt_units deleted from the service's SELECT.
      if (sql.includes("s.cpt_units")) return Promise.resolve([bill]);
      const rest = { ...bill };
      delete rest.cpt_units;
      return Promise.resolve([rest]);
    }
    if (sql.includes("FROM org WHERE")) return Promise.resolve([{ name: "Demo Palliative" }]);
    return Promise.resolve([]);
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)({ $queryRaw: run, $executeRaw: run }),
  );
  h.setContent.mockReset().mockResolvedValue(undefined);
  h.launch.mockResolvedValue({
    connected: true,
    newPage: async () => ({
      setContent: h.setContent,
      pdf: async () => new Uint8Array([37, 80, 68, 70]),
      close: async () => undefined,
    }),
  });
});

/** The CPT / HCPCS cell of the printed bill. */
async function codesCell(): Promise<string> {
  await generateSuperbillPdf({ orgId: ORG, userId: "u1", superbillId: SB });
  const html = h.setContent.mock.calls[0]![0] as string;
  const m = html.match(/CPT \/ HCPCS<\/td><td class="mono">([\s\S]*?)<\/td>/);
  expect(m, "could not find the CPT / HCPCS row").toBeTruthy();
  return m![1]!;
}

describe("the printed superbill's codes row", () => {
  it("CONTROL: prints the units beside the add-on that carries them", async () => {
    expect(await codesCell()).toBe("99350, G0318 ×3");
  });

  it("prints a bill saved before 0106 as the plain list it always was", async () => {
    bill = { ...bill, cpt_units: {} };
    expect(await codesCell()).toBe("99350, G0318");
  });

  it("CONTROL: escapes a stored code rather than emitting it as markup", async () => {
    bill = { ...bill, cpt_codes: ["99350", "<b>x</b>"], cpt_units: {} };
    expect(await codesCell()).toBe("99350, &lt;b&gt;x&lt;/b&gt;");
  });
});
