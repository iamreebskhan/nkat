/**
 * The Billing dashboard's numbers.
 *
 * Covers the reads the client asked for on 20 Aug 2026 [14:00–14:07] — "how
 * many adjustments they've had to make… how many denials they've had, where
 * those denials were" — plus the two guards that keep the page honest: money
 * totals that exclude drafts and voided bills, and a truncation flag so a
 * capped list is never presented as the whole book.
 *
 * lib/db is mocked with a fake tx that dispatches on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import {
  getBillingOverview,
  listBillableClients,
  listBillableVisits,
} from "../billing-overview.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "f0000000-0000-4000-8000-000000000001";

const ZERO_TOTALS = {
  draft: BigInt(0), ready_to_submit: BigInt(0), submitted: BigInt(0), paid: BigInt(0),
  partially_paid: BigInt(0), denied: BigInt(0), voided: BigInt(0),
  billed_cents: BigInt(0), paid_cents: BigInt(0), paid_remittance_cents: BigInt(0),
  outstanding_cents: BigInt(0),
};

type DenialRow = {
  payer_id: string | null;
  payer_name: string | null;
  carc_code: string;
  denial_reason: string | null;
  cpt_code: string;
  amount: bigint | null;
  /** 'remittance' when posted from a payer's 835 (audit R10). */
  source?: string | null;
};

let db: {
  totals: Record<string, bigint | null>;
  byClient: Record<string, unknown>[];
  byNurse: Record<string, unknown>[];
  denials: DenialRow[];
  adjustments: { kind: string; c: bigint; claims: bigint }[];
  claimsAffected: bigint;
  billableClients: Record<string, unknown>[];
  billableVisits: Record<string, unknown>[];
};

let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });

    if (sql.includes("AS ready_to_submit")) return Promise.resolve([db.totals]);
    if (sql.includes("JOIN patient p ON p.id = s.patient_id")) return Promise.resolve(db.byClient);
    if (sql.includes("JOIN visit v ON v.id = s.visit_id")) return Promise.resolve(db.byNurse);
    if (sql.includes("FROM superbill_denial d")) return Promise.resolve(db.denials);
    if (sql.includes("AS c FROM superbill_activity")) {
      return Promise.resolve([{ c: db.claimsAffected }]);
    }
    if (sql.includes("GROUP BY kind")) return Promise.resolve(db.adjustments);
    if (sql.includes("FROM patient p")) return Promise.resolve(db.billableClients);
    if (sql.includes("LEFT JOIN app_user u ON u.id = v.clinician_user_id")) {
      // The bill's date and the org's zone come back only when the statement
      // selects them, the zone only from an org joined on the visit's own org.
      const billDos = /\bs\.date_of_service AS superbill_dos\b/.test(sql);
      const zone = /\bo\.timezone AS org_timezone\b/.test(sql) && /\bJOIN org o ON o\.id = v\.org_id\b/.test(sql);
      return Promise.resolve(
        db.billableVisits.map((r) => {
          const row = { ...r };
          if (!billDos) delete row.superbill_dos;
          if (!zone) delete row.org_timezone;
          return row;
        }),
      );
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

const find = (frag: string) => calls.find((c) => c.sql.includes(frag));

const denial = (o: Partial<DenialRow> = {}): DenialRow => ({
  payer_id: "pay-1", payer_name: "Medicare", carc_code: "50",
  denial_reason: "Not deemed a medical necessity", cpt_code: "99345",
  amount: BigInt(12000), ...o,
});

beforeEach(() => {
  calls = [];
  db = {
    totals: { ...ZERO_TOTALS },
    byClient: [],
    byNurse: [],
    denials: [],
    adjustments: [],
    claimsAffected: BigInt(0),
    billableClients: [],
    billableVisits: [],
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("getBillingOverview — totals", () => {
  it("converts every count and amount out of bigint", async () => {
    db.totals = {
      draft: BigInt(3), ready_to_submit: BigInt(2), submitted: BigInt(7), paid: BigInt(5),
      partially_paid: BigInt(1), denied: BigInt(4), voided: BigInt(1),
      billed_cents: BigInt(1_234_500), paid_cents: BigInt(900_000),
      paid_remittance_cents: BigInt(9_850),
      outstanding_cents: BigInt(334_500),
    };
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.totals).toEqual({
      draft: 3, readyToSubmit: 2, submitted: 7, paid: 5, partiallyPaid: 1, denied: 4, voided: 1,
      billedCents: 1_234_500, paidCents: 900_000, paidFromRemittanceCents: 9_850,
      outstandingCents: 334_500, needsAttention: 4,
    });
    expect(Number.isSafeInteger(o.totals.billedCents)).toBe(true);
  });

  it("reads a null SUM as zero rather than NaN", async () => {
    db.totals = { ...ZERO_TOTALS, billed_cents: null, paid_cents: null, outstanding_cents: null };
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.totals.billedCents).toBe(0);
    expect(o.totals.outstandingCents).toBe(0);
  });

  it("excludes drafts and voided bills from money, but still counts them", async () => {
    // A draft was never raised and a voided bill was cancelled — neither is a
    // charge. The pipeline chips still want the counts.
    await getBillingOverview({ orgId: ORG });
    const totals = find("AS ready_to_submit")!.sql;
    expect(totals).toMatch(
      /SUM\(billed_amount_cents\)\s+FILTER \(WHERE status NOT IN \('draft', 'voided'\)\)/,
    );
    expect(totals).toContain("COUNT(*) FILTER (WHERE status = 'draft')");
  });

  it("counts only submitted and partially paid bills as outstanding", async () => {
    await getBillingOverview({ orgId: ORG });
    expect(find("AS ready_to_submit")!.sql).toMatch(
      /FILTER \(WHERE status IN \('submitted', 'partially_paid'\)\), 0\) AS outstanding_cents/,
    );
  });
});

/**
 * "Showing the busiest only — there are more" used to be inferred from a full
 * page: `byClient.length >= limit`. An org with exactly `limit` billing
 * clients — the whole list, nothing hidden — was told to go looking for rows
 * that do not exist, and a banner that cries wolf is one people stop reading.
 * Each list now asks for one row beyond the page and trims it off.
 */
describe("getBillingOverview — 'there are more' is answered by the data", () => {
  const clientRow = (i: number) => ({
    patient_id: PATIENT,
    patient_name: `Client ${i}`,
    payer_name: null,
    bills: BigInt(1),
    billed_cents: BigInt(100),
    paid_cents: BigInt(0),
    denied_count: BigInt(0),
    last_activity_at: null,
  });
  const nurseRow = (i: number) => ({
    clinician_user_id: PATIENT,
    clinician_name: `Nurse ${i}`,
    bills: BigInt(1),
    submitted: BigInt(0),
    paid: BigInt(0),
    denied: BigInt(0),
    billed_cents: BigInt(100),
  });

  it("claims nothing is hidden when the list is exactly the page size", async () => {
    db.byClient = Array.from({ length: 5 }, (_, i) => clientRow(i));
    db.byNurse = Array.from({ length: 5 }, (_, i) => nurseRow(i));
    const o = await getBillingOverview({ orgId: ORG, limit: 5 });
    expect(o.byClient).toHaveLength(5);
    expect(o.byNurse).toHaveLength(5);
    expect(o.truncated).toEqual({ byClient: false, byNurse: false });
  });

  it("says there is more only when a row beyond the page came back — and never shows that row", async () => {
    db.byClient = Array.from({ length: 6 }, (_, i) => clientRow(i));
    db.byNurse = Array.from({ length: 6 }, (_, i) => nurseRow(i));
    const o = await getBillingOverview({ orgId: ORG, limit: 5 });
    expect(o.truncated).toEqual({ byClient: true, byNurse: true });
    // The probe row is trimmed: the page shows what it promised, no more.
    expect(o.byClient).toHaveLength(5);
    expect(o.byNurse).toHaveLength(5);
    expect(o.byClient.map((r) => r.patientName)).not.toContain("Client 5");
  });

  it("asks the database for exactly one row more than it shows", async () => {
    await getBillingOverview({ orgId: ORG, limit: 5 });
    const clients = calls.find((c) => c.sql.includes("JOIN patient p ON p.id = s.patient_id"))!;
    const nurses = calls.find((c) => c.sql.includes("JOIN visit v ON v.id = s.visit_id"))!;
    expect(clients.values).toContain(6);
    expect(nurses.values).toContain(6);
  });
});

describe("getBillingOverview — per client and per nurse", () => {
  it("maps a client row, including a null payer", async () => {
    db.byClient = [
      {
        patient_id: PATIENT, patient_name: "Ruth Alvarez", payer_name: null,
        bills: BigInt(3), billed_cents: BigInt(45_000), paid_cents: BigInt(30_000),
        denied_count: BigInt(1), last_activity_at: new Date("2026-09-08T09:30:00Z"),
      },
    ];
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.byClient[0]).toEqual({
      patientId: PATIENT, patientName: "Ruth Alvarez", payerName: null,
      bills: 3, billedCents: 45_000, paidCents: 30_000, deniedCount: 1,
      lastActivityAt: "2026-09-08T09:30:00.000Z",
    });
  });

  it("keeps a client with no activity date rather than dropping the row", async () => {
    db.byClient = [
      {
        patient_id: PATIENT, patient_name: "Ruth Alvarez", payer_name: "Medicare",
        bills: BigInt(1), billed_cents: BigInt(0), paid_cents: BigInt(0),
        denied_count: BigInt(0), last_activity_at: null,
      },
    ];
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.byClient[0]!.lastActivityAt).toBeNull();
  });

  it("maps a nurse row and tolerates an unnamed clinician", async () => {
    db.byNurse = [
      {
        clinician_user_id: "u1", clinician_name: null, bills: BigInt(9),
        submitted: BigInt(6), paid: BigInt(4), denied: BigInt(2), billed_cents: BigInt(88_000),
      },
    ];
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.byNurse[0]).toEqual({
      clinicianUserId: "u1", clinicianName: null, bills: 9,
      submitted: 6, paid: 4, denied: 2, billedCents: 88_000,
    });
  });

  it("attributes a bill to the visit's clinician, not the bill's creator", async () => {
    await getBillingOverview({ orgId: ORG });
    expect(find("JOIN visit v ON v.id = s.visit_id")!.sql).toContain("SELECT v.clinician_user_id");
  });
});

describe("getBillingOverview — truncation", () => {
  const clientRows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      patient_id: `p${i}`, patient_name: `Patient ${i}`, payer_name: null,
      bills: BigInt(1), billed_cents: BigInt(0), paid_cents: BigInt(0),
      denied_count: BigInt(0), last_activity_at: null,
    }));

  it("is not truncated when the list came back short of the cap", async () => {
    db.byClient = clientRows(24);
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.truncated).toEqual({ byClient: false, byNurse: false });
  });

  // This pair used to be one test asserting the opposite: that a list merely
  // FILLING the cap is truncated. That was the defect written down as an
  // expectation — 25 clients, the whole book, and the page said "Showing the
  // busiest only — there are more" with nothing behind it. Each list now asks
  // for one row past the page, so the question is answered, not guessed.
  it("is not truncated when the list exactly fills the cap — that is the whole book", async () => {
    db.byClient = clientRows(25);
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.truncated.byClient).toBe(false);
    expect(o.byClient).toHaveLength(25);
  });

  it("flags truncation only when a row beyond the cap came back", async () => {
    db.byClient = clientRows(26);
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.truncated.byClient).toBe(true);
    // And the row it asked for as a probe never reaches the page.
    expect(o.byClient).toHaveLength(25);
  });

  it("defaults the page to 25, asking for one more to answer the question", async () => {
    db.byClient = clientRows(40);
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.byClient).toHaveLength(25);
    expect(find("JOIN patient p ON p.id = s.patient_id")!.values).toContain(26);
  });

  it("clamps a caller's cap to 1–100, and still shows no more than the clamp", async () => {
    db.byClient = clientRows(200);
    const wide = await getBillingOverview({ orgId: ORG, limit: 5000 });
    expect(wide.byClient).toHaveLength(100);
    expect(find("JOIN patient p ON p.id = s.patient_id")!.values).toContain(101);
    calls = [];
    const zero = await getBillingOverview({ orgId: ORG, limit: 0 });
    expect(zero.byClient).toHaveLength(1);
    expect(find("JOIN patient p ON p.id = s.patient_id")!.values).toContain(2);
    calls = [];
    const negative = await getBillingOverview({ orgId: ORG, limit: -3 });
    expect(negative.byClient).toHaveLength(1);
    expect(find("JOIN patient p ON p.id = s.patient_id")!.values).toContain(2);
  });
});

describe("getBillingOverview — what a payer's 835 posted (audit R10)", () => {
  it("reads the remittance-confirmed part of Collected from paid_source", async () => {
    await getBillingOverview({ orgId: ORG });
    expect(find("AS ready_to_submit")!.sql).toMatch(
      /AND paid_source = 'remittance'\), 0\) AS paid_remittance_cents/,
    );
  });

  it("CONTROL — nothing posted from a remittance reads as zero, not as the whole of Collected", async () => {
    db.totals = { ...ZERO_TOTALS, paid_cents: BigInt(11_401), paid_remittance_cents: BigInt(0) };
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.totals.paidCents).toBe(11_401);
    expect(o.totals.paidFromRemittanceCents).toBe(0);
  });

  it("counts the denials a payer's 835 posted, read from d.source", async () => {
    db.denials = [
      denial(),
      denial({ carc_code: "16", source: "remittance" }),
      denial({ carc_code: "UNCODED", denial_reason: null, source: "recorded" }),
    ];
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.denials.fromRemittance).toBe(1);
    expect(o.denials.total).toBe(3);
    expect(o.denials.withoutReason).toBe(1);
    expect(find("FROM superbill_denial d")!.sql).toContain("d.source");
  });
});

describe("getBillingOverview — denials", () => {
  it("reports zero without inventing groups", async () => {
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.denials).toEqual({
      total: 0, withoutReason: 0, fromRemittance: 0, byPayer: [], byReason: [], byCode: [],
    });
  });

  it("counts every recorded denial, and how many still lack a reason", async () => {
    // A denial recorded without a payer reason code is work to do, not zero.
    db.denials = [
      denial(),
      denial({ carc_code: "UNCODED", denial_reason: null }),
      denial({ carc_code: "UNCODED", denial_reason: null }),
    ];
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.denials.total).toBe(3);
    expect(o.denials.withoutReason).toBe(2);
  });

  it("groups by payer and sums the denied amount", async () => {
    db.denials = [
      denial({ payer_id: "pay-1", payer_name: "Medicare", amount: BigInt(12_000) }),
      denial({ payer_id: "pay-1", payer_name: "Medicare", amount: BigInt(8_000) }),
      denial({ payer_id: "pay-2", payer_name: "Aetna", amount: BigInt(5_000) }),
    ];
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.denials.byPayer).toEqual([
      { key: "pay-1", label: "Medicare", count: 2, amountCents: 20_000 },
      { key: "pay-2", label: "Aetna", count: 1, amountCents: 5_000 },
    ]);
  });

  it("names an unattributed payer instead of dropping the denial", async () => {
    db.denials = [denial({ payer_id: null, payer_name: null })];
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.denials.byPayer).toEqual([
      { key: "unknown", label: "Payer not recorded", count: 1, amountCents: 12_000 },
    ]);
  });

  it("labels a reason group with its CARC code and text", async () => {
    db.denials = [denial({ carc_code: "50", denial_reason: "Not deemed a medical necessity" })];
    expect((await getBillingOverview({ orgId: ORG })).denials.byReason[0]!.label).toBe(
      "50 — Not deemed a medical necessity",
    );
  });

  it("falls back to the bare CARC code when no text came with it", async () => {
    db.denials = [denial({ carc_code: "97", denial_reason: null })];
    expect((await getBillingOverview({ orgId: ORG })).denials.byReason[0]!.label).toBe("97");
  });

  it("says plainly when the reason has not been recorded yet", async () => {
    db.denials = [denial({ carc_code: "UNCODED", denial_reason: null })];
    expect((await getBillingOverview({ orgId: ORG })).denials.byReason[0]!.label).toBe(
      "Reason not recorded yet",
    );
  });

  it("groups by CPT so a code that keeps getting denied is visible", async () => {
    db.denials = [
      denial({ cpt_code: "99345" }),
      denial({ cpt_code: "99345" }),
      denial({ cpt_code: "99497" }),
    ];
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.denials.byCode.map((g) => [g.key, g.count])).toEqual([
      ["99345", 2],
      ["99497", 1],
    ]);
  });

  it("orders every grouping by count, largest first", async () => {
    db.denials = [
      denial({ payer_id: "a", payer_name: "A" }),
      denial({ payer_id: "b", payer_name: "B" }),
      denial({ payer_id: "b", payer_name: "B" }),
      denial({ payer_id: "c", payer_name: "C" }),
      denial({ payer_id: "c", payer_name: "C" }),
      denial({ payer_id: "c", payer_name: "C" }),
    ];
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.denials.byPayer.map((g) => g.count)).toEqual([3, 2, 1]);
  });

  it("treats a missing denied amount as zero", async () => {
    db.denials = [denial({ amount: null }), denial({ amount: BigInt(5_000) })];
    expect((await getBillingOverview({ orgId: ORG })).denials.byPayer[0]!.amountCents).toBe(5_000);
  });

  it("excludes written-off denials — they are closed, not open work", async () => {
    await getBillingOverview({ orgId: ORG });
    expect(find("FROM superbill_denial d")!.sql).toContain("d.outcome <> 'written_off'");
  });
});

describe("getBillingOverview — adjustments", () => {
  it("is zero across the board when nothing has been reworked", async () => {
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.adjustments).toEqual({ edits: 0, refiles: 0, total: 0, claimsAffected: 0 });
  });

  it("counts edits and refiles separately and together", async () => {
    db.adjustments = [
      { kind: "edited", c: BigInt(7), claims: BigInt(4) },
      { kind: "resubmitted", c: BigInt(3), claims: BigInt(3) },
    ];
    db.claimsAffected = BigInt(5);
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.adjustments).toEqual({ edits: 7, refiles: 3, total: 10, claimsAffected: 5 });
  });

  it("counts a claim once however many times it was touched", async () => {
    // 7 edits across 4 claims plus 3 refiles is not 10 claims.
    db.adjustments = [{ kind: "edited", c: BigInt(7), claims: BigInt(4) }];
    db.claimsAffected = BigInt(4);
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.adjustments.total).toBe(7);
    expect(o.adjustments.claimsAffected).toBe(4);
  });

  it("reports zero for a kind the activity trail has none of", async () => {
    db.adjustments = [{ kind: "resubmitted", c: BigInt(2), claims: BigInt(2) }];
    db.claimsAffected = BigInt(2);
    const o = await getBillingOverview({ orgId: ORG });
    expect(o.adjustments.edits).toBe(0);
    expect(o.adjustments.refiles).toBe(2);
  });

  it("counts operational rework only — edited and resubmitted", async () => {
    // Deliberately not contractual adjustments; conflating the two misreports
    // money.
    await getBillingOverview({ orgId: ORG });
    expect(find("GROUP BY kind")!.sql).toContain("kind IN ('edited', 'resubmitted')");
  });

  it("excludes edits made while the claim was still a draft", async () => {
    // The superbill editor autosaves every 5 seconds and each autosave writes
    // an 'edited' activity row, so counting draft-stage edits put about one
    // "adjustment" per 5 seconds of authoring into this figure. Building a
    // claim is not adjusting it.
    await getBillingOverview({ orgId: ORG });
    expect(find("GROUP BY kind")!.sql).toContain("from_status IS DISTINCT FROM 'draft'");
    expect(find("AS c FROM superbill_activity")!.sql).toContain(
      "from_status IS DISTINCT FROM 'draft'",
    );
  });

  it("uses IS DISTINCT FROM so a null from_status still counts", async () => {
    // `from_status <> 'draft'` is NULL for a row with no recorded status, and
    // NULL drops the row — silently undercounting real rework.
    await getBillingOverview({ orgId: ORG });
    expect(find("GROUP BY kind")!.sql).not.toMatch(/from_status\s*<>\s*'draft'/);
  });
});

describe("listBillableClients", () => {
  it("formats the date of birth as a plain date and counts unbilled visits", async () => {
    db.billableClients = [
      {
        patient_id: PATIENT, name: "Ruth Alvarez", dob: new Date("1948-03-11T00:00:00Z"),
        status: "deceased", payer_name: "Medicare",
        billable_visits: BigInt(6), unbilled_visits: BigInt(2),
      },
    ];
    const rows = await listBillableClients({ orgId: ORG });
    expect(rows[0]).toEqual({
      patientId: PATIENT, name: "Ruth Alvarez", dob: "1948-03-11", status: "deceased",
      payerName: "Medicare", billableVisits: 6, unbilledVisits: 2,
    });
  });

  it("tolerates a patient with no recorded date of birth", async () => {
    db.billableClients = [
      {
        patient_id: PATIENT, name: "Ruth Alvarez", dob: null, status: "active",
        payer_name: null, billable_visits: BigInt(1), unbilled_visits: BigInt(1),
      },
    ];
    expect((await listBillableClients({ orgId: ORG }))[0]!.dob).toBeNull();
  });

  it("keys off billable visits, not patient status", async () => {
    // The plain patient list defaults to 'active', which hid discharged and
    // deceased patients — the normal end states in palliative care, whose
    // claims are still filed afterwards.
    await listBillableClients({ orgId: ORG });
    const sql = find("FROM patient p")!.sql;
    expect(sql).toContain("JOIN visit v ON v.patient_id = p.id");
    expect(sql).toContain("v.status IN ('in_progress', 'documented', 'pending_billing', 'billed')");
    expect(sql).not.toContain("p.status = 'active'");
  });
});

describe("listBillableVisits", () => {
  it("maps a visit that already has a superbill so the UI can say so", async () => {
    db.billableVisits = [
      {
        visit_id: "v1", visit_type: "new_patient_home", status: "documented",
        dos: new Date("2026-09-09T15:00:00Z"), clinician_name: "N. Okafor",
        superbill_id: "s1", superbill_status: "submitted", billed_amount_cents: BigInt(21_000),
        superbill_dos: new Date("2026-09-09T00:00:00Z"), org_timezone: "America/New_York",
      },
    ];
    const rows = await listBillableVisits({ orgId: ORG, patientId: PATIENT });
    expect(rows[0]).toEqual({
      visitId: "v1", visitType: "new_patient_home", status: "documented",
      dateOfService: "2026-09-09", clinicianName: "N. Okafor",
      superbillId: "s1", superbillStatus: "submitted", billedAmountCents: 21_000,
    });
  });

  it("keeps an unbilled visit's amount null rather than reporting it as zero", async () => {
    db.billableVisits = [
      {
        visit_id: "v2", visit_type: "established_patient_home", status: "in_progress",
        dos: null, clinician_name: null,
        superbill_id: null, superbill_status: null, billed_amount_cents: null,
        superbill_dos: null, org_timezone: "America/New_York",
      },
    ];
    const rows = await listBillableVisits({ orgId: ORG, patientId: PATIENT });
    expect(rows[0]!.billedAmountCents).toBeNull();
    expect(rows[0]!.dateOfService).toBeNull();
  });

  it("CONTROL: dates an unbilled 8:30 pm EDT visit on the practice's day, not as a UTC instant", async () => {
    // Create Bill printed the instant's first ten characters: the UTC day, so
    // a visit on the evening of the 9th was offered as the 10th.
    db.billableVisits = [
      {
        visit_id: "v3", visit_type: "established_patient_home", status: "documented",
        dos: new Date("2026-09-10T00:30:00Z"), clinician_name: null,
        superbill_id: null, superbill_status: null, billed_amount_cents: null,
        superbill_dos: null, org_timezone: "America/New_York",
      },
    ];
    const rows = await listBillableVisits({ orgId: ORG, patientId: PATIENT });
    expect(rows[0]!.dateOfService).toBe("2026-09-09");
  });

  it("CONTROL: the org's own zone decides: 10:30 pm PDT on the 9th is the 9th in Los Angeles", async () => {
    // 05:30Z on the 10th, which is already 1:30 am on the 10th in New York.
    db.billableVisits = [
      {
        visit_id: "v5", visit_type: "established_patient_home", status: "documented",
        dos: new Date("2026-09-10T05:30:00Z"), clinician_name: null,
        superbill_id: null, superbill_status: null, billed_amount_cents: null,
        superbill_dos: null, org_timezone: "America/Los_Angeles",
      },
    ];
    const rows = await listBillableVisits({ orgId: ORG, patientId: PATIENT });
    expect(rows[0]!.dateOfService).toBe("2026-09-09");
  });

  it("CONTROL: a billed visit shows its bill's date of service, as stored", async () => {
    // A bill saved before the fix, dated the evening visit's UTC day: the
    // picker says what the claim says, not a date the bill does not carry.
    db.billableVisits = [
      {
        visit_id: "v4", visit_type: "established_patient_home", status: "billed",
        dos: new Date("2026-09-10T00:30:00Z"), clinician_name: null,
        superbill_id: "s4", superbill_status: "submitted", billed_amount_cents: BigInt(7013),
        superbill_dos: new Date("2026-09-10T00:00:00Z"), org_timezone: "America/New_York",
      },
    ];
    const rows = await listBillableVisits({ orgId: ORG, patientId: PATIENT });
    expect(rows[0]!.dateOfService).toBe("2026-09-10");
  });

  it("offers only encounters that actually happened", async () => {
    // Billing a cancelled, no-show or not-yet-happened visit is a false claim.
    await listBillableVisits({ orgId: ORG, patientId: PATIENT });
    const q = find("LEFT JOIN app_user u ON u.id = v.clinician_user_id")!;
    expect(q.sql).toContain("v.status IN ('in_progress', 'documented', 'pending_billing', 'billed')");
    expect(q.values).toContain(PATIENT);
  });
});

describe("Create Bill leaves out Not billed visit types (audit R18)", () => {
  // The server refuses to draft a bill for them, so offering one led only to
  // an error, and each counted as a client's unbilled work for good. A visit
  // billed before its type was re-banded stays, so its bill can be opened.
  const NOT_BILLED =
    /\(s\.id IS NOT NULL OR NOT EXISTS \(\s*SELECT 1 FROM org_visit_type ot\s+WHERE ot\.org_id = v\.org_id AND ot\.slug = v\.visit_type\s+AND ot\.coding_basis = 'non_billable'\)\)/;

  it("the appointment list skips them", async () => {
    await listBillableVisits({ orgId: ORG, patientId: PATIENT });
    expect(find("LEFT JOIN app_user u ON u.id = v.clinician_user_id")!.sql).toMatch(NOT_BILLED);
  });

  it("the client list counts by the same rule", async () => {
    await listBillableClients({ orgId: ORG });
    expect(find("FROM patient p")!.sql).toMatch(NOT_BILLED);
  });
});
