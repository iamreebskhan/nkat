/**
 * The superbill list carries what each code means.
 *
 * Every row always carried its CPT codes — rowToView maps cpt_codes — but the
 * billing list screens rendered only a date and a dollar amount, so what a
 * claim actually billed was invisible without opening it. The descriptors
 * were sitting in the rulebook-fed `code` table the whole time (all 112 codes
 * have one locally). listSuperbills now joins them, once per page.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/billing/code.service", () => ({ hasAmaLicense: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { AMA_PLACEHOLDER } from "@/lib/features/billing/code-pure";
import { hasAmaLicense } from "@/lib/features/billing/code.service";

import { countSuperbills, listSuperbills } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const P = "f0000000-0000-4000-8000-000000000001";

const row = (id: string, cpt: string[]) => ({
  id, visit_id: "v-" + id, patient_id: "p1", payer_id: null, member_id_snapshot: "M1",
  date_of_service: new Date("2026-09-09T00:00:00Z"),
  cpt_codes: cpt, icd10_codes: [], modifiers: [],
  provider_npi: "1234567890", provider_name: "N. Okafor", place_of_service_code: "12",
  patient_name: "Stephen Singleton",
  billed_amount_cents: BigInt(21_000), paid_amount_cents: null, status: "submitted",
  submitted_at: null, paid_at: null, generated_pdf_path: null, predicted_risk: null,
  created_at: new Date("2026-09-09T10:00:00Z"), updated_at: new Date("2026-09-09T10:00:00Z"),
});

let superbills: ReturnType<typeof row>[];
let codeTable: { code: string; code_system: string; short_descriptor: string | null }[];
let calls: { sql: string; values: unknown[] }[] = [];
/** What the COUNT query answers. */
let countN = 0;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("COUNT(*)")) return Promise.resolve([{ n: BigInt(countN) }]);
    if (sql.includes("FROM superbill s")) return Promise.resolve(superbills);
    if (sql.includes("FROM code c")) return Promise.resolve(codeTable);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

const codeQueries = () => calls.filter((c) => c.sql.includes("FROM code c"));

beforeEach(() => {
  calls = [];
  countN = 0;
  superbills = [row("a", ["99344"]), row("b", ["99349", "99497"])];
  codeTable = [
    { code: "99344", code_system: "CPT", short_descriptor: "Home visit, new pt, mod MDM/60min" },
    { code: "99349", code_system: "CPT", short_descriptor: "Home visit, est pt, mod MDM/40min" },
    { code: "99497", code_system: "CPT", short_descriptor: "Advance care planning, first 30 min" },
  ];
  // The assertions above read the text: a licensed deployment.
  vi.mocked(hasAmaLicense).mockReturnValue(true);
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("listSuperbills", () => {
  it("still returns the codes themselves — the field the screens render", async () => {
    const rows = await listSuperbills({ orgId: ORG });
    expect(rows.map((r) => r.cptCodes)).toEqual([["99344"], ["99349", "99497"]]);
  });

  it("attaches the rulebook descriptor to every code on every row", async () => {
    const rows = await listSuperbills({ orgId: ORG });
    expect(rows[0]!.codeDescriptors).toEqual({ "99344": "Home visit, new pt, mod MDM/60min" });
    expect(rows[1]!.codeDescriptors).toEqual({
      "99349": "Home visit, est pt, mod MDM/40min",
      "99497": "Advance care planning, first 30 min",
    });
  });

  it("keeps a code the reference does not know, as null — never drops it", async () => {
    // A claim carrying a code nobody can describe is the one a biller most
    // needs to see; silently omitting the code would hide it.
    superbills = [row("a", ["99344", "G9999"])];
    const rows = await listSuperbills({ orgId: ORG });
    expect(rows[0]!.codeDescriptors).toEqual({
      "99344": "Home visit, new pt, mod MDM/60min",
      G9999: null,
    });
  });

  it("looks descriptors up once per page, with each code asked for once", async () => {
    // Not a query per claim: 50 rows must not mean 50 round trips.
    superbills = [row("a", ["99349"]), row("b", ["99349"]), row("c", ["99344", "99349"])];
    await listSuperbills({ orgId: ORG });
    expect(codeQueries()).toHaveLength(1);
    const asked = codeQueries()[0]!.values[0] as string[];
    expect([...asked].sort()).toEqual(["99344", "99349"]);
  });

  it("skips the lookup entirely when no row carries a code", async () => {
    superbills = [row("a", [])];
    const rows = await listSuperbills({ orgId: ORG });
    expect(codeQueries()).toHaveLength(0);
    expect(rows[0]!.codeDescriptors).toEqual({});
  });

  it("reads the code version in force today, the same rule as the CPT bands", async () => {
    // `code` is versioned by effective_date. A future revision must not
    // relabel today's claims, and an expired one must not linger.
    await listSuperbills({ orgId: ORG });
    const sql = codeQueries()[0]!.sql;
    expect(sql).toContain("DISTINCT ON (c.code)");
    expect(sql).toContain("c.effective_date <= CURRENT_DATE");
    expect(sql).toContain("c.expiration_date IS NULL OR c.expiration_date > CURRENT_DATE");
    expect(sql).toContain("ORDER BY c.code, c.effective_date DESC");
  });
});

describe("listSuperbills — whose claim, and which page (audit R16, R34)", () => {
  const listQuery = () => calls.filter((c) => c.sql.includes("FROM superbill s"));

  it("carries the patient's name on every row, joined in the same query", async () => {
    const rows = await listSuperbills({ orgId: ORG });
    expect(rows.map((r) => r.patientName)).toEqual(["Stephen Singleton", "Stephen Singleton"]);
    expect(listQuery()).toHaveLength(1);
    expect(listQuery()[0]!.sql).toContain("JOIN patient p ON p.id = s.patient_id");
    // One list query plus one descriptor query: no lookup per row.
    expect(calls).toHaveLength(2);
  });

  it("keeps the ids a row links with: visit, patient and clinician", async () => {
    const [r] = await listSuperbills({ orgId: ORG });
    expect(r!.visitId).toBe("v-a");
    expect(r!.patientId).toBe("p1");
    expect(r!.providerName).toBe("N. Okafor");
  });

  it("carries the Claim ref a payer's 835 echoes back, and where the paid amount came from (audit R10)", async () => {
    superbills = [
      {
        ...row("b2e303af-e2cb-4292-8d00-c35c07423a0d", ["99344"]),
        paid_amount_cents: BigInt(9850),
        paid_source: "remittance",
      } as unknown as ReturnType<typeof row>,
    ];
    const [r] = await listSuperbills({ orgId: ORG });
    expect(r!.claimRef).toBe("B2E303AFE2CB");
    expect(r!.paidAmountCents).toBe(9850);
    expect(r!.paidSource).toBe("remittance");
  });

  it("CONTROL — an unpaid row, as read before 0102, has no paid source", async () => {
    const [r] = await listSuperbills({ orgId: ORG });
    expect(r!.paidSource).toBeNull();
  });

  it("pages with OFFSET and filters by patient in SQL", async () => {
    await listSuperbills({ orgId: ORG, offset: 50, patientId: P });
    const q = listQuery()[0]!;
    expect(q.sql).toContain("OFFSET");
    expect(q.sql).toContain("s.patient_id = ");
    expect(q.values).toContain(50);
    expect(q.values).toContain(P);
  });

  it("clamps a negative offset to 0", async () => {
    await listSuperbills({ orgId: ORG, offset: -5 });
    expect(listQuery()[0]!.values).toContain(0);
    expect(listQuery()[0]!.values).not.toContain(-5);
  });
});

describe("countSuperbills", () => {
  it("counts the whole filtered queue, not one page", async () => {
    countN = 61;
    expect(await countSuperbills({ orgId: ORG, status: "draft", patientId: P })).toBe(61);
    const q = calls.find((c) => c.sql.includes("COUNT(*)"))!;
    expect(q.sql).toContain("s.status = ");
    expect(q.sql).toContain("s.patient_id = ");
    expect(q.sql).not.toContain("LIMIT");
    expect(q.values).toContain("draft");
    expect(q.values).toContain(P);
  });
});

describe("listSuperbills — the AMA descriptor gate (audit R21)", () => {
  it("withholds CPT text on an unlicensed deployment, keeping the code", async () => {
    vi.mocked(hasAmaLicense).mockReturnValue(false);
    const rows = await listSuperbills({ orgId: ORG });
    expect(rows[0]!.codeDescriptors).toEqual({ "99344": AMA_PLACEHOLDER });
    expect(rows[1]!.codeDescriptors).toEqual({ "99349": AMA_PLACEHOLDER, "99497": AMA_PLACEHOLDER });
  });

  it("never withholds HCPCS Level II, which is CMS public domain", async () => {
    vi.mocked(hasAmaLicense).mockReturnValue(false);
    superbills = [row("a", ["G0318"])];
    codeTable = [{ code: "G0318", code_system: "HCPCS2", short_descriptor: "Prolonged home E/M" }];
    const rows = await listSuperbills({ orgId: ORG });
    expect(rows[0]!.codeDescriptors).toEqual({ G0318: "Prolonged home E/M" });
  });

  it("keeps 'not in the code reference' distinct from 'withheld'", async () => {
    vi.mocked(hasAmaLicense).mockReturnValue(false);
    superbills = [row("a", ["99344", "G9999"])];
    const rows = await listSuperbills({ orgId: ORG });
    expect(rows[0]!.codeDescriptors).toEqual({ "99344": AMA_PLACEHOLDER, G9999: null });
  });

  it("reads the code system with the descriptor, in the same query", async () => {
    await listSuperbills({ orgId: ORG });
    expect(codeQueries()).toHaveLength(1);
    expect(codeQueries()[0]!.sql).toContain("c.code_system");
  });
});
