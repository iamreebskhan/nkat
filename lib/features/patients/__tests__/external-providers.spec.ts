/**
 * Outside providers on a patient (audit R30): the link schema, NPI check
 * digits, reuse of the roster row that holds an NPI, one PCP per patient, and
 * the audit rows.
 *
 * lib/db is mocked with a fake tx that dispatches on the SQL text; writeAudit
 * is mocked so its payloads can be read. The roster lookups by NPI are the
 * exception: they go to sql-fake, which RUNS the statement the service wrote
 * against in-memory rows, so their predicates decide the answer here. So do
 * the patient check, the roster read by id and the roster list, over two orgs'
 * rows with the other org's first and no RLS: a statement that forgets its org
 * reaches the other practice's patient or doctor before its own.
 */
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { prepare, run as runSql } from "@/lib/features/team/__tests__/sql-fake";

import {
  ExternalProviderSchema,
  LinkExternalProviderSchema,
  NpiSchema,
} from "../contacts.types";
import {
  linkPatientProvider,
  listOrgProviders,
  listPatientProviders,
  unlinkPatientProvider,
  updateOrgProvider,
} from "../external-providers.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "44444444-4444-4444-8444-444444444444";
/** A second chart in the SAME org — RLS does not separate these two. */
const OTHER_PATIENT = "44444444-4444-4444-8444-44444444bbbb";
const USER = "55555555-5555-4555-8555-555555555555";
const EXISTING = "88888888-8888-4888-8888-888888888888";
const OTHER_PROVIDER = "88888888-8888-4888-8888-8888888888bb";
/** A third roster row, holding an NPI nobody asks about. */
const DECOY_PROVIDER = "88888888-8888-4888-8888-8888888888cc";
const DECOY_NPI = "1932475820";
const NEW_PROVIDER = "99999999-9999-4999-8999-999999999999";
const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** A link id that is real, but belongs to OTHER_PATIENT's chart. */
const OTHER_LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaabbb";
/** Another practice, its patient, and a doctor on ITS roster. */
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const FOREIGN_PATIENT = "44444444-4444-4444-8444-4444444444ff";
const FOREIGN_PROVIDER = "88888888-8888-4888-8888-8888888888ff";
const FOREIGN_LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaafff";

let calls: { sql: string; values: unknown[] }[] = [];
/**
 * external_provider as ROWS. The service's lookups by NPI are RUN against
 * these by sql-fake, so what they return is decided by the statement, not by
 * this file. Every row is in ORG: those statements leave the tenant boundary
 * to RLS, which sql-fake does not model.
 */
let roster: {
  id: string; org_id: string; npi: string | null; active: boolean;
  full_name: string; specialty: string | null; practice_name: string | null; phone: string | null; fax: string | null;
}[];
const ROSTER_COLUMNS = ["id", "org_id", "npi", "active", "full_name", "specialty", "practice_name", "phone", "fax"];
const doctor = (id: string, org_id: string, npi: string | null, full_name: string) => ({
  id, org_id, npi, active: true, full_name, specialty: null, practice_name: null, phone: null, fax: null,
});
/** Puts an NPI on one of those rows. */
const holds = (id: string, npi: string) => {
  roster.find((r) => r.id === id)!.npi = npi;
};
/** Roles this patient already has filled. */
let heldRoles: string[];
/** patient_external_provider as rows, so a statement can miss. */
let links: { id: string; patient_id: string; role: string; external_provider_id: string }[];
/** What the link INSERT or the roster UPDATE throws instead of returning. */
let linkError: unknown;
let rosterUpdateError: unknown;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    // Collapse the statement's own whitespace before dispatching. The
    // roster-edit NPI probe is written over three lines, so its text reads
    // "external_provider\n         WHERE npi" and matched none of the
    // branches below: it fell through to the default empty result, the
    // duplicate-NPI pre-check could therefore never find a clash, and
    // deleting the whole pre-check left this spec green (audit R30).
    const sql = strings.join("¶").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (sql.includes("SELECT id FROM patient WHERE")) {
      const patients = [
        { id: FOREIGN_PATIENT, org_id: OTHER_ORG },
        { id: PATIENT, org_id: ORG },
        { id: OTHER_PATIENT, org_id: ORG },
      ];
      return Promise.resolve(runSql({ patient: { columns: ["id", "org_id"], rows: patients } }, strings, values));
    }
    if (sql.includes("DELETE FROM patient_external_provider")) {
      // Link ROWS, not a restatement of the guard: the statement's own binds
      // choose which of them it deletes. Drop `AND patient_id = $2` from the
      // unlink (or bind the column to itself) and the second bind goes with
      // it, so this hands back OTHER_PATIENT's row and the 404 below fails.
      const [id, patientId] = values as [string, string | undefined];
      const hit = links.find(
        (l) => l.id === id && (patientId === undefined || l.patient_id === patientId),
      );
      return Promise.resolve(
        hit ? [{ id: hit.id, role: hit.role, external_provider_id: hit.external_provider_id }] : [],
      );
    }
    if (sql.includes("FROM external_provider WHERE npi")) {
      // sql-fake RUNS this statement — `WHERE npi = $1 AND id <> $2` on the
      // roster edit, `WHERE npi = $1` when a link reuses a row — against the
      // rows above. It used to be answered in JavaScript
      // (`id && id !== excluded`), which hardcoded the `<>`: flipping the
      // shipped operator to `=`, so that a row keeping its own NPI clashes
      // with itself and the row that really holds it is missed, left both
      // behavioural tests below green and died only on the SQL text
      // (round-six verifier, mutant ep.selfeq). sql-fake also fails closed:
      // a rewrite it cannot model says so instead of passing.
      return Promise.resolve(
        runSql({ external_provider: { columns: ROSTER_COLUMNS, rows: roster } }, strings, values),
      );
    }
    if (sql.includes("FROM external_provider WHERE id")) {
      return Promise.resolve(runSql({ external_provider: { columns: ROSTER_COLUMNS, rows: roster } }, strings, values));
    }
    // The roster list with no search: sql-fake runs it, lower() read as the
    // value itself (the names here sort the same either way). It has no ILIKE,
    // so a search falls through to the default and the binds test below.
    if (sql.includes("FROM external_provider WHERE active") && values[1] === null) {
      const statement = prepare(strings).replace(/\blower\(([^()]+)\)/g, "$1");
      return Promise.resolve(runSql({ external_provider: { columns: ROSTER_COLUMNS, rows: roster } }, [statement], values));
    }
    if (sql.includes("INSERT INTO external_provider")) return Promise.resolve([{ id: NEW_PROVIDER }]);
    if (sql.includes("INSERT INTO patient_external_provider")) {
      return linkError ? Promise.reject(linkError) : Promise.resolve([{ id: LINK }]);
    }
    if (sql.includes("UPDATE external_provider")) {
      // The row the statement names: the bind after `WHERE id =`.
      const at = sql.slice(0, sql.indexOf("WHERE id = ¶")).split("¶").length - 1;
      return rosterUpdateError
        ? Promise.reject(rosterUpdateError)
        : Promise.resolve([
            { id: values[at], full_name: "Dr Alan Brooks", npi: null, specialty: null,
              practice_name: null, phone: null, fax: null },
          ]);
    }
    if (sql.includes("FROM patient_external_provider") && !sql.includes("external_provider_id =")) {
      return Promise.resolve(heldRoles.includes(values[1] as string) ? [{ id: "held" }] : []);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

const audited = () => vi.mocked(writeAudit).mock.calls.map((c) => c[1]);
const linkInsert = () => calls.find((c) => c.sql.includes("INSERT INTO patient_external_provider"));
const providerInsert = () => calls.find((c) => c.sql.includes("INSERT INTO external_provider"));

beforeEach(() => {
  calls = [];
  // Three same-org rows, none of them holding the NPI under test until a case
  // says so. DECOY_PROVIDER holds an unrelated one and comes first, so a probe
  // that stops asking about the NPI it was given (`WHERE npi IS NOT NULL`)
  // finds it: the roster edit refuses a save that should go through, and a
  // link reuses the wrong provider.
  roster = [
    // Another practice's doctor, FIRST, holding the NPI most cases below use:
    // the same PCP on two practices' rosters is the ordinary case.
    doctor(FOREIGN_PROVIDER, OTHER_ORG, "1234567893", "Dr Alan Brooks (their roster)"),
    doctor(DECOY_PROVIDER, ORG, DECOY_NPI, "Dr Decoy"),
    doctor(EXISTING, ORG, null, "Dr Existing"),
    doctor(OTHER_PROVIDER, ORG, null, "Dr Other"),
  ];
  heldRoles = [];
  links = [
    { id: LINK, patient_id: PATIENT, role: "specialist", external_provider_id: EXISTING },
    { id: OTHER_LINK, patient_id: OTHER_PATIENT, role: "primary_care", external_provider_id: NEW_PROVIDER },
  ];
  linkError = null;
  rosterUpdateError = null;
  vi.mocked(writeAudit).mockReset();
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const BROOKS = { fullName: "Dr Alan Brooks", npi: "1234567893", specialty: "Internal medicine", phone: "614-555-0100" };
const base = { orgId: ORG, userId: USER, patientId: PATIENT };

describe("provider schemas", () => {
  it("a specialist must be labelled", () => {
    expect(LinkExternalProviderSchema.safeParse({ role: "specialist", provider: BROOKS }).success).toBe(false);
    expect(
      LinkExternalProviderSchema.safeParse({ role: "specialist", roleLabel: "Pulmonologist", provider: BROOKS }).success,
    ).toBe(true);
  });

  it("an NPI must pass its check digit", () => {
    expect(NpiSchema.safeParse("1234567890").success).toBe(false);
    expect(NpiSchema.safeParse("1234567893").success).toBe(true);
    expect(ExternalProviderSchema.safeParse({ ...BROOKS, npi: "1234567890" }).success).toBe(false);
  });

  it("takes a roster id or a new provider — never both, never neither", () => {
    expect(
      LinkExternalProviderSchema.safeParse({ role: "primary_care", externalProviderId: EXISTING, provider: BROOKS }).success,
    ).toBe(false);
    expect(LinkExternalProviderSchema.safeParse({ role: "primary_care" }).success).toBe(false);
    expect(LinkExternalProviderSchema.safeParse({ role: "primary_care", externalProviderId: EXISTING }).success).toBe(true);
  });
});

describe("linkPatientProvider", () => {
  it("reuses the roster row holding the NPI: no new provider, and the link names it", async () => {
    holds(EXISTING, "1234567893");
    const r = await linkPatientProvider({ ...base, input: { role: "primary_care", provider: BROOKS } });
    expect(providerInsert()).toBeUndefined();
    expect(linkInsert()!.values).toEqual([ORG, PATIENT, EXISTING, "primary_care", null, USER]);
    expect(r).toEqual({ linkId: LINK, providerId: EXISTING, providerCreated: false });
  });

  it("adds a new provider to the roster, then links it", async () => {
    const r = await linkPatientProvider({
      ...base,
      input: { role: "specialist", roleLabel: "Pulmonologist", provider: { fullName: "Dr Priya Nair" } },
    });
    const iProvider = calls.findIndex((c) => c.sql.includes("INSERT INTO external_provider"));
    const iLink = calls.findIndex((c) => c.sql.includes("INSERT INTO patient_external_provider"));
    expect(iProvider).toBeGreaterThan(-1);
    expect(iLink).toBeGreaterThan(iProvider);
    expect(calls[iLink]!.values).toEqual([ORG, PATIENT, NEW_PROVIDER, "specialist", "Pulmonologist", USER]);
    expect(r.providerCreated).toBe(true);
    // A name alone is not an identity: there is nothing to match it on.
    expect(calls.some((c) => c.sql.includes("FROM external_provider WHERE npi"))).toBe(false);
  });

  it("refuses a second primary care provider before touching the roster", async () => {
    heldRoles = ["primary_care"];
    await expect(
      linkPatientProvider({ ...base, input: { role: "primary_care", provider: BROOKS } }),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("already has a primary care provider"),
    });
    expect(calls.some((c) => c.sql.includes("INSERT INTO"))).toBe(false);
  });

  it("allows any number of specialists", async () => {
    heldRoles = ["primary_care", "specialist"];
    await linkPatientProvider({ ...base, input: { role: "specialist", roleLabel: "Oncologist", externalProviderId: EXISTING } });
    expect(linkInsert()!.values).toEqual([ORG, PATIENT, EXISTING, "specialist", "Oncologist", USER]);
  });

  it("drops a label on a role whose label is fixed", async () => {
    await linkPatientProvider({ ...base, input: { role: "referring", roleLabel: "Anything", externalProviderId: EXISTING } });
    expect(linkInsert()!.values[4]).toBeNull();
  });

  it("audits the link as patient_provider_change — ids and role, no name", async () => {
    await linkPatientProvider({
      ...base,
      input: { role: "specialist", roleLabel: "Pulmonologist", provider: { fullName: "Dr Priya Nair", phone: "614-555-0101" } },
    });
    const link = audited().find((e) => e.action === "patient_provider_change");
    expect(link).toMatchObject({ targetType: "patient", targetId: PATIENT });
    expect(link!.payload).toEqual({
      linkId: LINK, providerId: NEW_PROVIDER, op: "link", role: "specialist", providerCreated: true,
    });
    // The new roster row starts its own trail.
    expect(audited().find((e) => e.action === "external_provider_change")).toMatchObject({
      targetType: "external_provider",
      targetId: NEW_PROVIDER,
      payload: { op: "create", fields: ["full_name", "phone"] },
    });
    const json = JSON.stringify(audited().map((e) => e.payload));
    expect(json).not.toContain("Nair");
    expect(json).not.toContain("614-555-0101");
  });
});

/**
 * Unlinking is bounded to the chart in the URL. /api/patients/[id]/providers/
 * [linkId] takes both ids from the path, and patient_external_provider's RLS
 * is org-scoped only, so `AND patient_id = $2` is the whole of what makes a
 * linkId from a DIFFERENT chart a 404 rather than a silent unlink — one that
 * would file its audit row against the patient in the URL, who never had that
 * provider. Nothing exercised this function at all before (audit R30).
 */
describe("unlinkPatientProvider", () => {
  it("removes the link on this chart and audits it by id", async () => {
    await expect(unlinkPatientProvider({ ...base, linkId: LINK })).resolves.toEqual({ unlinked: true });
    expect(audited()[0]).toMatchObject({
      action: "patient_provider_change",
      targetType: "patient",
      targetId: PATIENT,
      payload: { linkId: LINK, providerId: EXISTING, op: "unlink", role: "specialist" },
    });
  });

  it("404s a link id that belongs to another patient's chart, and audits nothing", async () => {
    await expect(unlinkPatientProvider({ ...base, linkId: OTHER_LINK })).rejects.toMatchObject({
      name: "NotFoundError",
      message: "That provider is not linked to this patient.",
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("bounds the DELETE by the chart as well as the link id", async () => {
    await unlinkPatientProvider({ ...base, linkId: LINK });
    const del = calls.find((c) => c.sql.includes("DELETE FROM patient_external_provider"))!;
    expect(del.values).toEqual([LINK, PATIENT, ORG]);
  });
});

describe("another practice's roster and charts", () => {
  it("adds a doctor another practice has on file to THIS roster, rather than linking theirs", async () => {
    const r = await linkPatientProvider({ ...base, input: { role: "primary_care", provider: BROOKS } });
    expect(providerInsert()).toBeDefined();
    expect(r).toEqual({ linkId: LINK, providerId: NEW_PROVIDER, providerCreated: true });
    expect(linkInsert()!.values).not.toContain(FOREIGN_PROVIDER);
  });

  it("refuses their roster entry by id: not found, nothing linked", async () => {
    await expect(
      linkPatientProvider({ ...base, input: { role: "specialist", roleLabel: "Oncologist", externalProviderId: FOREIGN_PROVIDER } }),
    ).rejects.toMatchObject({ name: "NotFoundError", message: "Provider not found." });
    expect(linkInsert()).toBeUndefined();
  });

  it("an NPI on their roster is no clash with this one", async () => {
    await expect(
      updateOrgProvider({ orgId: ORG, userId: USER, providerId: EXISTING, patch: { npi: "1234567893" } }),
    ).resolves.toMatchObject({ id: EXISTING });
  });

  it("lists this practice's roster only", async () => {
    const rows = await listOrgProviders({ orgId: ORG });
    expect(rows.map((r) => r.id).sort()).toEqual([DECOY_PROVIDER, EXISTING, OTHER_PROVIDER].sort());
  });

  it("their patient: no providers listed, linked or unlinked, nothing audited", async () => {
    const theirs = { orgId: ORG, userId: USER, patientId: FOREIGN_PATIENT };
    await expect(listPatientProviders(theirs)).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(
      linkPatientProvider({ ...theirs, input: { role: "specialist", roleLabel: "Oncologist", externalProviderId: EXISTING } }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(unlinkPatientProvider({ ...theirs, linkId: FOREIGN_LINK })).rejects.toMatchObject({
      name: "NotFoundError",
    });
    expect(calls.filter((c) => /INSERT INTO|DELETE FROM/.test(c.sql))).toEqual([]);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe("listOrgProviders", () => {
  it("escapes LIKE wildcards and matches an exact NPI", async () => {
    await listOrgProviders({ orgId: ORG, q: " 50%_x " });
    const q = calls.find((c) => c.sql.includes("FROM external_provider"))!;
    expect(q.sql).toContain("WHERE active");
    expect(q.values).toContain("%50\\%\\_x%");
    expect(q.values).toContain("50%_x");
  });
});

/**
 * What Prisma really throws when a $queryRaw statement hits a unique index:
 * P2010 with the SQLSTATE in meta.code, and no index name anywhere (audit
 * R30). The old check looked for the name, so each race below was a 500.
 */
const prismaRawError = (sqlState: string, message: string) =>
  new PrismaClientKnownRequestError(`Raw query failed. Code: \`${sqlState}\`. Message: \`${message}\``, {
    code: "P2010",
    clientVersion: "6.2.1",
    meta: { code: sqlState, message },
  });
const uniqueViolation = () => prismaRawError("23505", "Unique constraint failed: ");

describe("a link that loses a race to the unique indexes (R30)", () => {
  it("a second PCP answers with the one-PCP refusal (422), and audits nothing", async () => {
    linkError = uniqueViolation();
    await expect(
      linkPatientProvider({ ...base, input: { role: "primary_care", externalProviderId: EXISTING } }),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("already has a primary care provider"),
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("a second referrer answers with the one-referrer refusal", async () => {
    linkError = uniqueViolation();
    await expect(
      linkPatientProvider({ ...base, input: { role: "referring", externalProviderId: EXISTING } }),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("already has a referring physician"),
    });
  });

  it("a specialist linked twice answers that the provider is already linked in that role", async () => {
    linkError = uniqueViolation();
    await expect(
      linkPatientProvider({
        ...base,
        input: { role: "specialist", roleLabel: "Oncologist", externalProviderId: EXISTING },
      }),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: "That provider is already linked to this patient in that role.",
    });
  });

  it("CONTROL: any other database error still propagates as itself", async () => {
    const fk = prismaRawError("23503", "Foreign key constraint violated");
    linkError = fk;
    await expect(
      linkPatientProvider({
        ...base,
        input: { role: "specialist", roleLabel: "Oncologist", externalProviderId: EXISTING },
      }),
    ).rejects.toBe(fk);
  });
});

/**
 * The duplicate-NPI pre-check on a roster edit. It exists so the 422 names the
 * rule instead of surfacing a raw unique-index error, and it has to leave the
 * row being edited out of its own check: without `AND id <> $2` every save
 * that keeps its NPI (fixing a fax number, say) is refused with "Another
 * provider on your roster already has that NPI" — about itself. Neither half
 * was exercised: the probe never reached its fixture, so deleting the whole
 * pre-check left the spec green (audit R30).
 */
describe("a roster edit against an NPI already on the roster (R30)", () => {
  const edit = () =>
    updateOrgProvider({ orgId: ORG, userId: USER, providerId: EXISTING, patch: { npi: "1234567893" } });

  it("saves a row that keeps its own NPI — it is not a clash with itself", async () => {
    holds(EXISTING, "1234567893");
    await expect(edit()).resolves.toMatchObject({ id: EXISTING });
    expect(audited()).toEqual([
      expect.objectContaining({ action: "external_provider_change", payload: { op: "update", fields: ["npi"] } }),
    ]);
  });

  it("refuses when another roster row holds that NPI, and writes nothing", async () => {
    holds(OTHER_PROVIDER, "1234567893");
    await expect(edit()).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("already has that NPI"),
    });
    expect(calls.some((c) => c.sql.includes("UPDATE external_provider"))).toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("asks about the NPI being saved, and excludes the row being edited", async () => {
    holds(EXISTING, "1234567893");
    await edit();
    const probe = calls.find((c) => c.sql.includes("FROM external_provider WHERE npi"));
    expect(probe, "the edit sent no duplicate-NPI probe at all").toBeDefined();
    expect(probe!.values).toEqual(["1234567893", EXISTING, ORG]);
    // Belt-and-braces, the schedule-clinician-membership.spec.ts pattern: the
    // two tests above pin what the probe answers, this catches a probe
    // rewritten to ask something else entirely (`WHERE npi IS NOT NULL`).
    expect(probe!.sql).toContain("WHERE npi = ¶ AND id <> ¶::uuid");
  });
});

describe("a roster edit that loses the race for an NPI (R30)", () => {
  const edit = () =>
    updateOrgProvider({ orgId: ORG, userId: USER, providerId: EXISTING, patch: { npi: "1234567893" } });

  it("answers with the NPI refusal (422), and audits nothing", async () => {
    rosterUpdateError = uniqueViolation();
    await expect(edit()).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("already has that NPI"),
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("CONTROL: any other database error still propagates as itself, and an edit that wins still saves", async () => {
    const fk = prismaRawError("23503", "Foreign key constraint violated");
    rosterUpdateError = fk;
    await expect(edit()).rejects.toBe(fk);
    rosterUpdateError = null;
    await expect(edit()).resolves.toMatchObject({ id: EXISTING });
    expect(audited()).toEqual([
      expect.objectContaining({ action: "external_provider_change", payload: { op: "update", fields: ["npi"] } }),
    ]);
  });
});
