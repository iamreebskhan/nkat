/**
 * A signed note is an attestation. documentVisit must refuse edits once the
 * visit is signed, or a claim ends up supported by documentation nobody
 * attested to — the editor's autosave-on-blur used to keep rewriting it.
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: vi.fn(),
}));

import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { documentVisit, getVisit, scheduleVisit } from "../visit.service";
import { DocumentVisitSchema } from "../visit.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "22222222-2222-4222-8222-222222222222";
const CLINICIAN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let currentStatus: string;
/** org_visit_type.is_telehealth for the visit's type; null = no such active type. */
let typeIsTelehealth: boolean | null;
/** user_ids the fake org_member table holds as active members of ORG. */
let activeMembers: string[];
/** The visit row getVisit reads, as stored. */
let storedVisit: Record<string, unknown>;
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    // getVisit's read. The row carries cpt_units only when the statement
    // selects it, as in Postgres.
    if (sql.includes("AS signer_name")) {
      if (sql.includes("v.cpt_units")) return Promise.resolve([storedVisit]);
      const rest = { ...storedVisit };
      delete rest.cpt_units;
      return Promise.resolve([rest]);
    }
    if (sql.includes("SELECT id, status FROM visit")) {
      return Promise.resolve(currentStatus ? [{ id: VISIT, status: currentStatus }] : []);
    }
    if (sql.includes("FROM pos")) {
      return Promise.resolve(["12", "13", "31"].includes(values[0] as string) ? [{ ok: 1 }] : []);
    }
    if (sql.includes("SELECT t.is_telehealth")) {
      return Promise.resolve(typeIsTelehealth === null ? [] : [{ is_telehealth: typeIsTelehealth }]);
    }
    // scheduleVisit's type lookup. Bindings are (org_id, slug): the type is
    // one of ORG's, so no other org finds it.
    if (sql.includes("FROM org_visit_type")) {
      return Promise.resolve(
        typeIsTelehealth === null || values[0] !== ORG
          ? []
          : [{ slug: values[1], is_telehealth: typeIsTelehealth }],
      );
    }
    // scheduleVisit's patient guard. Answered explicitly for the same reason
    // as the member guard below. Bindings are (org_id, patient_id); the
    // patient is one of ORG's.
    if (sql.includes("FROM patient")) {
      return Promise.resolve(values[0] === ORG ? [{ ok: 1 }] : []);
    }
    // scheduleVisit's active-org-member guard. Answered explicitly: the
    // catch-all below returns 1, not a row array, which would have read as
    // "not a member" and failed every scheduleVisit case here for the wrong
    // reason. Bindings are (org_id, clinician_user_id).
    if (sql.includes("FROM org_member")) {
      return Promise.resolve(
        values[0] === ORG && activeMembers.includes(values[1] as string) ? [{ ok: 1 }] : [],
      );
    }
    if (sql.includes("INSERT INTO visit")) return Promise.resolve([{ id: VISIT }]);
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  calls = [];
  currentStatus = "in_progress";
  typeIsTelehealth = false;
  activeMembers = [CLINICIAN];
  storedVisit = {
    id: VISIT, patient_id: "f0000000-0000-4000-8000-000000000001", clinician_user_id: CLINICIAN,
    visit_type: "established_patient_home", visit_type_label: "Established patient — home",
    coding_basis: "established_patient_home", type_is_telehealth: false,
    scheduled_start: null, scheduled_end: null,
    start_time: new Date("2026-09-09T15:00:00Z"), stop_time: new Date("2026-09-09T17:50:00Z"),
    total_minutes: 170, acp_minutes: 0, prolonged_minutes: null,
    is_telehealth: false, telehealth_modality: null, telehealth_consent_documented: false,
    document_text: null, cpt_codes_assigned: ["99350", "G0318"], cpt_units: { G0318: 3 },
    icd10_codes: ["C34.90"], modifiers: [], status: "in_progress", signed_at: null,
    created_at: new Date("2026-09-09T14:00:00Z"), updated_at: new Date("2026-09-09T17:50:00Z"),
  };
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("documentVisit", () => {
  it("saves while the visit is still in progress", async () => {
    const r = await documentVisit({
      orgId: ORG,
      id: VISIT,
      payload: { documentText: "SUBJECTIVE: comfortable." },
    });
    expect(r).toEqual({ updated: true });
    expect(calls.some((c) => c.sql.includes("UPDATE visit SET"))).toBe(true);
  });

  it("saves a scheduled visit and bumps it to in_progress", async () => {
    currentStatus = "scheduled";
    await documentVisit({ orgId: ORG, id: VISIT, payload: { acpMinutes: 20 } });
    const upd = calls.find((c) => c.sql.includes("UPDATE visit SET"));
    expect(upd!.sql).toContain("'in_progress'");
  });

  for (const status of ["documented", "pending_billing", "billed"]) {
    it(`refuses to rewrite a ${status} visit, and writes nothing`, async () => {
      currentStatus = status;
      await expect(
        documentVisit({ orgId: ORG, id: VISIT, payload: { documentText: "tampered" } }),
      ).rejects.toThrow(/signed and submitted/i);
      expect(calls.some((c) => c.sql.includes("UPDATE visit SET"))).toBe(false);
    });
  }

  it("404s a missing visit rather than silently no-oping", async () => {
    currentStatus = "";
    await expect(
      documentVisit({ orgId: ORG, id: VISIT, payload: { acpMinutes: 5 } }),
    ).rejects.toThrow(/not found/i);
  });
});

/**
 * A note written into the legacy free-text column is a started note, so it
 * takes the same pin as a section save, carry-forward, vitals and sign-off:
 * the version it is written under, kept for the life of the note. Without it
 * a template edit reshaped such a note, which the settings screen promises it
 * never does. An untouched editor still serialises to a document, so the rule
 * is noteIsEmpty's, not `documentText != null`.
 */
describe("documentVisit — the legacy free-text note takes a pin", () => {
  /** The value bound right after `before` — the fake joins the SQL on ¶. */
  const bindAfter = (sql: string, values: unknown[], before: string) =>
    values[sql.slice(0, sql.indexOf(before) + before.length).split("¶").length - 1];
  const PIN = "note_template_id = CASE WHEN ";
  const upd = () => calls.find((c) => c.sql.includes("UPDATE visit SET"))!;
  const doc = (text: string) =>
    JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

  it("pins a visit with written text to its own version, else the active template", async () => {
    await documentVisit({ orgId: ORG, id: VISIT, payload: { documentText: doc("Comfortable today.") } });
    expect(upd().sql).toContain(PIN);
    // COALESCE, so a visit already pinned keeps the version it was written
    // under rather than being moved to whatever is active now.
    expect(upd().sql).toContain("THEN COALESCE(note_template_id,");
    expect(upd().sql).toContain("nt.org_id = visit.org_id AND nt.is_active");
    expect(bindAfter(upd().sql, upd().values, PIN)).toBe(true);
  });

  it("pins a legacy plain-text note, which is not JSON at all", async () => {
    await documentVisit({ orgId: ORG, id: VISIT, payload: { documentText: "SUBJECTIVE: comfortable." } });
    expect(bindAfter(upd().sql, upd().values, PIN)).toBe(true);
  });

  for (const [label, text] of [
    ["an untouched editor's empty document", '{"type":"doc","content":[]}'],
    ["one empty paragraph", '{"type":"doc","content":[{"type":"paragraph"}]}'],
    ["a paragraph of whitespace", doc("   ")],
  ] as const) {
    it(`CONTROL: ${label} starts no note, so it pins nothing`, async () => {
      await documentVisit({ orgId: ORG, id: VISIT, payload: { documentText: text } });
      expect(bindAfter(upd().sql, upd().values, PIN)).toBe(false);
    });
  }

  it("CONTROL: a save that carries no note at all pins nothing", async () => {
    await documentVisit({ orgId: ORG, id: VISIT, payload: { acpMinutes: 20 } });
    expect(bindAfter(upd().sql, upd().values, PIN)).toBe(false);
  });
});

describe("documentVisit — place of service (audit R23)", () => {
  it("records a real place-of-service code on the visit", async () => {
    await documentVisit({ orgId: ORG, id: VISIT, payload: { placeOfServiceCode: "13" } });
    const upd = calls.find((c) => c.sql.includes("UPDATE visit SET"))!;
    expect(upd.sql).toContain("place_of_service_code = COALESCE(");
    expect(upd.values).toContain("13");
  });

  it("refuses a code that is not a place of service, and writes nothing", async () => {
    await expect(
      documentVisit({ orgId: ORG, id: VISIT, payload: { placeOfServiceCode: "77" } }),
    ).rejects.toThrow(/Unknown place-of-service code "77"/);
    expect(calls.some((c) => c.sql.includes("UPDATE visit SET"))).toBe(false);
  });

  it("still refuses any edit to a signed visit", async () => {
    currentStatus = "pending_billing";
    await expect(
      documentVisit({ orgId: ORG, id: VISIT, payload: { placeOfServiceCode: "13" } }),
    ).rejects.toThrow(/signed and submitted/i);
  });
});

/**
 * Units per code (0106). The count the suggester makes reaches the visit only
 * beside the codes: `cpt_units` is bound when codes are sent and never on its
 * own, because '{}'::jsonb is a value and not a NULL, so a save that sent
 * units without codes — or an empty map on a save that meant "no opinion" —
 * would COALESCE over the visit's count exactly as an empty modifier array
 * once wiped the 95 (document-page-truthfulness.spec.ts).
 */
describe("documentVisit — units per code", () => {
  const UNITS = "cpt_units = COALESCE(";
  const upd = () => calls.find((c) => c.sql.includes("UPDATE visit SET"))!;
  /** The value bound right after `before` — the fake joins the SQL on ¶. */
  const unitsBind = () => {
    const { sql, values } = upd();
    expect(sql, "documentVisit no longer writes cpt_units").toContain(UNITS);
    return values[sql.slice(0, sql.indexOf(UNITS) + UNITS.length).split("¶").length - 1];
  };

  it("CONTROL: writes the count with the codes", async () => {
    await documentVisit({
      orgId: ORG,
      id: VISIT,
      payload: { cptCodesAssigned: ["99350", "G0318"], cptUnits: { G0318: 3 } },
    });
    expect(unitsBind()).toBe('{"G0318":3}');
  });

  it("resets the count to one unit per code when codes are sent alone", async () => {
    await documentVisit({ orgId: ORG, id: VISIT, payload: { cptCodesAssigned: ["99350"] } });
    expect(unitsBind()).toBe("{}");
  });

  it("leaves the count alone when no codes are sent", async () => {
    await documentVisit({ orgId: ORG, id: VISIT, payload: { acpMinutes: 20 } });
    expect(unitsBind()).toBeNull();
  });

  it("drops a key for a code that is not being assigned", async () => {
    await documentVisit({
      orgId: ORG,
      id: VISIT,
      payload: { cptCodesAssigned: ["99350"], cptUnits: { G0318: 3 } },
    });
    expect(unitsBind()).toBe("{}");
  });

  it("refuses units on a code billed once per visit, and writes nothing", async () => {
    const refused = documentVisit({
      orgId: ORG,
      id: VISIT,
      payload: { cptCodesAssigned: ["99350", "G0318"], cptUnits: { "99350": 2 } },
    });
    // A ValidationError, which the route answers 422; any other error is a 500.
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toThrow(/units apply only to/);
    expect(calls.some((c) => c.sql.includes("UPDATE visit SET"))).toBe(false);
  });

  it("the request schema refuses units without codes, and counts that are not 1–99", () => {
    const ok = DocumentVisitSchema.safeParse({ cptCodesAssigned: ["99350", "G0318"], cptUnits: { G0318: 3 } });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.cptUnits).toEqual({ G0318: 3 });
    expect(DocumentVisitSchema.safeParse({ cptUnits: { G0318: 3 } }).success).toBe(false);
    for (const bad of [0, 2.5, 100]) {
      expect(
        DocumentVisitSchema.safeParse({ cptCodesAssigned: ["G0318"], cptUnits: { G0318: bad } }).success,
        String(bad),
      ).toBe(false);
    }
  });
});

/**
 * getVisit feeds the document page, and the page's Save falls back to the
 * visit's own units when there is no suggestion (the code ladders not loaded).
 * A read that stopped selecting v.cpt_units would hand the page {}, and that
 * Save would COALESCE it over the visit's count. getVisit was only ever mocked,
 * so nothing would have noticed.
 */
describe("getVisit — the units reach the document page", () => {
  it("CONTROL: reads the visit's units into the view", async () => {
    const v = await getVisit({ orgId: ORG, id: VISIT });
    expect(v?.cptCodesAssigned).toEqual(["99350", "G0318"]);
    expect(v?.cptUnits).toEqual({ G0318: 3 });
  });

  it("reads a visit saved before 0106 as one unit per code", async () => {
    storedVisit = { ...storedVisit, cpt_units: {} };
    expect((await getVisit({ orgId: ORG, id: VISIT }))?.cptUnits).toEqual({});
  });
});

describe("documentVisit — a telehealth visit type (audit R22)", () => {
  // Clearing the box on a type that forces telehealth billed an in-person
  // visit (POS 12, no 95/93) for an encounter the org defined as telehealth.
  it("refuses to clear telehealth on a type that forces it, and writes nothing", async () => {
    typeIsTelehealth = true;
    await expect(
      documentVisit({ orgId: ORG, id: VISIT, payload: { isTelehealth: false } }),
    ).rejects.toThrow(ValidationError);
    expect(calls.some((c) => c.sql.includes("UPDATE visit SET"))).toBe(false);
  });

  it("CONTROL — an in-person type can clear the box", async () => {
    typeIsTelehealth = false;
    await documentVisit({ orgId: ORG, id: VISIT, payload: { isTelehealth: false } });
    const upd = calls.find((c) => c.sql.includes("UPDATE visit SET"))!;
    expect(upd.values).toContain(false);
  });

  it("CONTROL — ticking the box, or not sending it, never consults the type", async () => {
    typeIsTelehealth = true;
    await documentVisit({ orgId: ORG, id: VISIT, payload: { isTelehealth: true } });
    await documentVisit({ orgId: ORG, id: VISIT, payload: { acpMinutes: 5 } });
    expect(calls.some((c) => c.sql.includes("SELECT t.is_telehealth"))).toBe(false);
  });
});

describe("scheduleVisit — a telehealth visit type (audit R22)", () => {
  const payload = {
    patientId: "f0000000-0000-4000-8000-000000000001",
    clinicianUserId: CLINICIAN,
    visitType: "telehealth",
    scheduledStart: "2026-09-20T15:00:00Z",
    isTelehealth: false,
  };
  // values: org, patient, clinician, type, start, end, is_telehealth, modality
  const inserted = () => calls.find((c) => c.sql.includes("INSERT INTO visit"))!.values;

  it("schedules a flagged type as telehealth even with the box unticked", async () => {
    typeIsTelehealth = true;
    await scheduleVisit({ orgId: ORG, payload });
    expect(inserted()[6]).toBe(true);
    expect(inserted()[7]).toBe("audio_video");
  });

  it("keeps the modality the scheduler chose on a flagged type", async () => {
    typeIsTelehealth = true;
    await scheduleVisit({
      orgId: ORG,
      payload: { ...payload, isTelehealth: true, telehealthModality: "audio_only" },
    });
    expect(inserted()[6]).toBe(true);
    expect(inserted()[7]).toBe("audio_only");
  });

  it("CONTROL — an in-person type with the box unticked stays in person", async () => {
    typeIsTelehealth = false;
    await scheduleVisit({ orgId: ORG, payload: { ...payload, visitType: "established_patient_home" } });
    expect(inserted()[6]).toBe(false);
    expect(inserted()[7]).toBeNull();
  });

  it("CONTROL — the box still makes any type a telehealth visit", async () => {
    typeIsTelehealth = false;
    await scheduleVisit({
      orgId: ORG,
      payload: { ...payload, visitType: "new_patient_home", isTelehealth: true },
    });
    expect(inserted()[6]).toBe(true);
  });

  it("still refuses a slug that is not one of the org's active types", async () => {
    typeIsTelehealth = null;
    await expect(scheduleVisit({ orgId: ORG, payload })).rejects.toThrow(
      /not one of your visit types/,
    );
    expect(calls.some((c) => c.sql.includes("INSERT INTO visit"))).toBe(false);
  });
});
