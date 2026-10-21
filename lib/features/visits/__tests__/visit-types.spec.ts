/**
 * Org visit types after audit R22: telehealth is a flag on a type, never a
 * coding band.
 *
 * It used to be both. A type could bill "like Telehealth", which the CPT
 * suggester routed to the established ladder, so a new patient seen on it was
 * coded as an established one. 0099 drops 'telehealth' from the band CHECK;
 * these tests pin the service side of the same rule, and the seeded defaults
 * that signup writes, because a default whose band the CHECK refuses fails
 * every signup.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text, matching
 * document-lock.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/features/audit/audit-write")>()),
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { VISIT_TYPES } from "../visit.types";
import {
  CreateVisitTypeSchema,
  DEFAULT_VISIT_TYPES,
  UpdateVisitTypeSchema,
  createVisitType,
  listVisitTypes,
  slugifyVisitType,
  updateVisitType,
} from "../visit-types.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const TYPE_ID = "33333333-3333-4333-8333-333333333333";

let calls: { sql: string; values: unknown[] }[] = [];
let listRows: Record<string, unknown>[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT id FROM org_visit_type")) return Promise.resolve([]);
    if (sql.includes("INSERT INTO org_visit_type")) return Promise.resolve([{ id: TYPE_ID }]);
    if (sql.includes("FROM org_visit_type t")) return Promise.resolve(listRows);
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

const bands = VISIT_TYPES as readonly string[];

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  listRows = [];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("the visit-type schemas", () => {
  it("refuse 'telehealth' as a coding band", () => {
    expect(
      CreateVisitTypeSchema.safeParse({ label: "Video visit", codingBasis: "telehealth" }).success,
    ).toBe(false);
    expect(UpdateVisitTypeSchema.safeParse({ codingBasis: "telehealth" }).success).toBe(false);
  });

  it("take telehealth as a flag on a type that bills new or established", () => {
    const r = CreateVisitTypeSchema.safeParse({
      label: "Video follow-up",
      codingBasis: "established_patient_home",
      isTelehealth: true,
    });
    expect(r.success && r.data.isTelehealth).toBe(true);
    expect(UpdateVisitTypeSchema.safeParse({ isTelehealth: true }).success).toBe(true);
  });

  it("default the flag off, so an ordinary new type is an in-person visit", () => {
    const r = CreateVisitTypeSchema.parse({
      label: "Follow-up — assisted living",
      codingBasis: "established_patient_home",
    });
    expect(r.isTelehealth).toBe(false);
  });
});

describe("createVisitType", () => {
  const insert = () => calls.find((c) => c.sql.includes("INSERT INTO org_visit_type"))!;

  it("writes the flag into the INSERT, next to the band it bills as", async () => {
    await createVisitType({
      orgId: ORG,
      payload: { label: "Video follow-up", codingBasis: "established_patient_home", isTelehealth: true },
    });
    expect(insert().sql).toContain("is_telehealth");
    // values: org, slug, label, coding_basis, is_telehealth, (sort order is SQL)
    expect(insert().values[3]).toBe("established_patient_home");
    expect(insert().values[4]).toBe(true);
  });

  it("CONTROL — a type created without the flag is inserted in person", async () => {
    await createVisitType({
      orgId: ORG,
      payload: { label: "Follow-up — assisted living", codingBasis: "established_patient_home" },
    });
    expect(insert().values[4]).toBe(false);
  });

  it("audits the flag as a field value, nothing about any patient", async () => {
    await createVisitType({
      orgId: ORG,
      payload: { label: "Video follow-up", codingBasis: "new_patient_home", isTelehealth: true },
    });
    expect(vi.mocked(writeAudit).mock.calls[0]![1].payload).toEqual({
      change: "create",
      label: "Video follow-up",
      codingBasis: "new_patient_home",
      isTelehealth: true,
    });
  });
});

describe("updateVisitType", () => {
  it("changes the flag with the same COALESCE the other fields use, and audits its name", async () => {
    await updateVisitType({ orgId: ORG, id: TYPE_ID, payload: { isTelehealth: true } });
    const upd = calls.find((c) => c.sql.includes("UPDATE org_visit_type SET"))!;
    expect(upd.sql).toContain("is_telehealth = COALESCE(");
    expect(upd.values).toContain(true);
    expect(vi.mocked(writeAudit).mock.calls[0]![1].payload).toMatchObject({
      change: "edit",
      fields: ["isTelehealth"],
    });
  });

  it("CONTROL — leaves the flag alone when the edit does not mention it", async () => {
    await updateVisitType({ orgId: ORG, id: TYPE_ID, payload: { label: "Home visit" } });
    const upd = calls.find((c) => c.sql.includes("UPDATE org_visit_type SET"))!;
    expect(upd.values).not.toContain(true);
    expect(upd.values).not.toContain(false);
  });
});

describe("listVisitTypes", () => {
  it("returns the flag, and still marks the seeded telehealth type as built in", async () => {
    listRows = [
      {
        id: TYPE_ID, slug: "telehealth", label: "Established patient — telehealth",
        coding_basis: "established_patient_home", is_telehealth: true,
        active: true, sort_order: 40, usage_count: BigInt(3),
      },
    ];
    const [t] = await listVisitTypes({ orgId: ORG });
    expect(t).toMatchObject({
      slug: "telehealth",
      codingBasis: "established_patient_home",
      isTelehealth: true,
      builtIn: true,
      usageCount: 3,
    });
    expect(calls[0]!.sql).toContain("t.is_telehealth");
  });
});

describe("DEFAULT_VISIT_TYPES — what signup seeds", () => {
  it("declares only bands the CHECK accepts — the signup regression guard", () => {
    // Signup inserts each entry's codingBasis. One the 0099 CHECK refuses
    // rolls back the whole signup transaction.
    for (const t of DEFAULT_VISIT_TYPES) expect(bands).toContain(t.codingBasis);
    expect(DEFAULT_VISIT_TYPES.map((t) => t.codingBasis)).not.toContain("telehealth");
  });

  it("keeps the telehealth type, billed as established with the modality forced on", () => {
    const tele = DEFAULT_VISIT_TYPES.find((t) => t.slug === "telehealth")!;
    expect(tele).toMatchObject({
      label: "Established patient — telehealth",
      codingBasis: "established_patient_home",
      isTelehealth: true,
    });
  });

  it("flags nothing else as telehealth, and never repeats a slug", () => {
    expect(DEFAULT_VISIT_TYPES.filter((t) => t.isTelehealth).map((t) => t.slug)).toEqual([
      "telehealth",
    ]);
    const slugs = DEFAULT_VISIT_TYPES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("slugifyVisitType", () => {
  it("will not let a custom type take the seeded telehealth slug", () => {
    // 'telehealth' is no longer a band, but past visits and the note
    // template's exemptions still carry the slug; shadowing it would be silent.
    expect(slugifyVisitType("Telehealth")).toBe("telehealth_custom");
    expect(slugifyVisitType("Video follow-up")).toBe("video_follow_up");
  });
});

describe("audit R18 — a Not billed band, and no more inpatient consult", () => {
  it("the schemas accept Not billed as a band", () => {
    expect(
      CreateVisitTypeSchema.safeParse({ label: "Bereavement follow-up", codingBasis: "non_billable" })
        .success,
    ).toBe(true);
    expect(UpdateVisitTypeSchema.safeParse({ codingBasis: "non_billable" }).success).toBe(true);
  });

  it("the schemas refuse inpatient consult: nothing can code it, so it could never be signed", () => {
    expect(
      CreateVisitTypeSchema.safeParse({ label: "Hospital consult", codingBasis: "inpatient_consult" })
        .success,
    ).toBe(false);
    expect(UpdateVisitTypeSchema.safeParse({ codingBasis: "inpatient_consult" }).success).toBe(false);
  });

  it("signup no longer seeds inpatient consult", () => {
    expect(DEFAULT_VISIT_TYPES.map((t) => t.slug)).not.toContain("inpatient_consult");
    expect(DEFAULT_VISIT_TYPES.map((t) => t.codingBasis)).not.toContain("inpatient_consult");
  });

  it("re-bands a type in place with the COALESCE UPDATE, and audits field names only", async () => {
    await updateVisitType({
      orgId: ORG,
      id: TYPE_ID,
      payload: { label: "Bereavement visit", codingBasis: "non_billable" },
    });
    const upd = calls.find((c) => c.sql.includes("UPDATE org_visit_type SET"))!;
    expect(upd.sql).toContain("label = COALESCE(");
    expect(upd.sql).toContain("coding_basis = COALESCE(");
    expect(upd.values).toContain("Bereavement visit");
    expect(upd.values).toContain("non_billable");
    const payload = vi.mocked(writeAudit).mock.calls[0]![1].payload as { change: string; fields: string[] };
    expect(payload.change).toBe("edit");
    expect([...payload.fields].sort()).toEqual(["codingBasis", "label"]);
  });

  it("CONTROL — a rename alone sends no band, so the type keeps billing as it did", async () => {
    await updateVisitType({ orgId: ORG, id: TYPE_ID, payload: { label: "Follow-up — home" } });
    const upd = calls.find((c) => c.sql.includes("UPDATE org_visit_type SET"))!;
    // values: label, coding_basis, is_telehealth, active, id
    expect(upd.values.slice(0, 2)).toEqual(["Follow-up — home", null]);
  });

  it("an inpatient consult type an org already has still lists, as a built-in", async () => {
    listRows = [
      {
        id: TYPE_ID, slug: "inpatient_consult", label: "Inpatient consult",
        coding_basis: "inpatient_consult", is_telehealth: false,
        active: false, sort_order: 50, usage_count: BigInt(0),
      },
    ];
    const [t] = await listVisitTypes({ orgId: ORG, includeInactive: true });
    expect(t).toMatchObject({ codingBasis: "inpatient_consult", builtIn: true, active: false });
  });
});
