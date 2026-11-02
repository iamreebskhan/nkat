/**
 * The C-CDA export's service and route, and what intake and the chart write for
 * the USCDI fields (0128). The record read is the PDF's own (its SQL is tested in
 * patient-export.spec); what is tested here is what goes in the document, what
 * stays out, and that a whole chart leaving is on the accounting log.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn(), recordAuditDetached: vi.fn() }));
vi.mock("@/lib/hipaa/phi-access-log", () => ({ logPhiExport: vi.fn(), logPhiAccess: vi.fn() }));
vi.mock("../patient-export.service", () => ({ readPatientRecord: vi.fn() }));

import { GET } from "@/app/api/patients/[id]/export/ccda/route";
import { requireAuth, type Session } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { recordAuditDetached } from "@/lib/features/audit/audit-write";
import { logPhiAccess, logPhiExport } from "@/lib/hipaa/phi-access-log";

import { ccdFromRecord, exportPatientCcd } from "../ccda.service";
import { readPatientRecord } from "../patient-export.service";
import { UpdatePatientSchema } from "../patient.types";

type Rec = Awaited<ReturnType<typeof readPatientRecord>>;

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";

const visit = (over: Record<string, unknown>) => ({
  id: "v1", visit_type: "established_patient_home", visit_type_label: "Established visit", status: "documented",
  scheduled_start: new Date("2026-10-01T14:00:00Z"), start_time: new Date("2026-10-01T14:05:00Z"), total_minutes: 30,
  cpt_codes: ["99349"], icd10_codes: [], signed_at: null, signed_by_user_id: null, clinician_user_id: USER, signer_name: null, signer_credential: null, document_text: null,
  ...over,
});

const record = (over: Partial<Rec> = {}): Rec =>
  ({
    timeZone: "America/New_York",
    patient: {
      id: PATIENT, first_name: "Ruth", last_name: "Testcase", date_of_birth: new Date("1941-05-12T00:00:00Z"), primary_payer_name: null, primary_member_id: null,
      sex_assigned_at_birth: "X", address_line_1: "1 Main", city: "Columbus", state: "OH", zip: "43004", phone: null, race_codes: ["2106-3"], ethnicity_code: null, preferred_language: "es",
    },
    visits: [
      visit({}),
      visit({ id: "v2", status: "cancelled" }),
      visit({ id: "v3", status: "no_show" }),
      visit({ id: "v4", status: "scheduled", start_time: null, scheduled_start: new Date("2026-11-03T15:00:00Z"), cpt_codes: null }),
      visit({ id: "v5", visit_type: "pcm_ccm_month", status: "billed" }),
    ],
    superbills: [],
    carePlan: { goals_of_care_summary: "Stay at home.", updated_at: new Date() },
    notes: { sections: [], vitals: [{ visit_id: "v1", heart_rate: 72 }, { visit_id: "v2", heart_rate: 99 }], addenda: [] },
    careTeam: { contacts: [], providers: [], priorAuths: [] },
    clinicalLists: {
      problems: [{ id: "p1", icd10: "C34.90", description: "Lung cancer", status: "active", onset_on: null, resolved_on: null }],
      medications: [{ id: "m1", name: "lisinopril", dose: null, route: null, frequency: null, prn: false, indication: null, status: "active", started_on: null, stopped_on: null, stop_reason: null, rxnorm_cui: "29046" }],
      allergies: [],
      no_known_allergies_at: new Date(),
    },
    course: { admitted_on: null, discharges: [], acuity: [], hospice: [], events: [] },
    careManagement: { enrollments: [], time: [], charges: [] },
    ...over,
  }) as unknown as Rec;

const NOW = new Date("2026-10-31T12:00:00Z");
const ORG_INFO = { id: ORG, name: "P", phone: null, line1: null, city: null, state: null, zip: null, npi: null };
const shape = (rec = record()) => ccdFromRecord({ rec, documentId: "d", now: NOW, org: ORG_INFO, author: { name: "A B", npi: null } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readPatientRecord).mockResolvedValue(record());
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER, orgId: ORG, role: "org_admin", permissions: ["patients.view"], email: "a@b.test" } as Session);
  const run = (strings: TemplateStringsArray) => {
    const sql = strings.join("¶");
    if (sql.includes("FROM org o")) return Promise.resolve([{ name: "Practice", npi: "1234567893", line1: null, city: null, state: null, zip: null }]);
    if (sql.includes("FROM app_user")) return Promise.resolve([{ name: "Helen Okafor", npi: null }]);
    return Promise.resolve([]);
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)({ $queryRaw: run }));
});

describe("what goes in the document", () => {
  it("counts only visits that happened as encounters, and a booked one as planned", () => {
    const c = shape();
    expect(c.encounters.map((e) => e.id)).toEqual(["v1"]);
    expect(c.planned.map((e) => e.id)).toEqual(["v4"]);
  });

  it("dates a visit on the practice's calendar", () => {
    const late = shape(record({ visits: [visit({ start_time: new Date("2026-10-02T02:00:00Z") })] as never }));
    expect(late.encounters[0]!.day).toBe("2026-10-01");
  });

  it("leaves out the vitals of a visit that did not happen", () => {
    expect(shape().vitals.map((v) => v.id)).toEqual(["v1"]);
  });

  it("gives a sex the guide has no code for as unknown, not a guess", () => {
    expect(shape().patient.sex).toBe("U");
  });

  it("carries the USCDI fields, the RxNorm code and no known allergies", () => {
    const c = shape();
    expect(c.patient).toMatchObject({ raceCodes: ["2106-3"], ethnicity: null, language: "es" });
    expect(c.medications[0]!.rxnormCui).toBe("29046");
    expect(c.noKnownAllergies).toBe(true);
    expect(c.goals).toBe("Stay at home.");
  });
});

describe("the download", () => {
  const req = () => new Request(`http://localhost/api/patients/${PATIENT}/export/ccda`, { headers: { "user-agent": "t" } }) as unknown as NextRequest;
  const ctx = { params: Promise.resolve({ id: PATIENT }) };

  it("puts it on the accounting log, once, with its size", async () => {
    const { xml } = await exportPatientCcd({ orgId: ORG, userId: USER, patientId: PATIENT, now: NOW });
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(logPhiExport).toHaveBeenCalledTimes(1);
    expect(logPhiExport).toHaveBeenCalledWith({ orgId: ORG, userId: USER, exportType: "patient_ccda", patientIds: [PATIENT], byteSize: Buffer.byteLength(xml) });
  });

  it("needs patients.view, answers XML as a download, and audits the export and the read", async () => {
    const res = await GET(req(), ctx);
    expect(vi.mocked(requireAuth).mock.calls[0]![0]).toEqual(["patients.view"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="patient-ccd-${PATIENT}.xml"`);
    expect(vi.mocked(recordAuditDetached).mock.calls[0]![0]).toMatchObject({ action: "patient_export", targetId: PATIENT, payload: { format: "ccda" } });
    expect(logPhiAccess).toHaveBeenCalledWith(expect.objectContaining({ accessType: "export", context: "patient_ccda", patientId: PATIENT }));
  });

  it("CONTROL: refused, it reads nothing and logs nothing", async () => {
    vi.mocked(requireAuth).mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect((await GET(req(), ctx)).status).toBe(403);
    expect(readPatientRecord).not.toHaveBeenCalled();
    expect(logPhiExport).not.toHaveBeenCalled();
  });
});

describe("the chart's PATCH", () => {
  it("takes the USCDI fields, an empty race clearing it", () => {
    expect(UpdatePatientSchema.safeParse({ demographics: { raceCodes: ["2106-3"], ethnicity: "2135-2", preferredLanguage: "es" } }).success).toBe(true);
    expect(UpdatePatientSchema.safeParse({ demographics: { raceCodes: [], ethnicity: null, preferredLanguage: null } }).success).toBe(true);
  });

  it("CONTROL: refuses a code that is not on the list", () => {
    expect(UpdatePatientSchema.safeParse({ demographics: { raceCodes: ["White"] } }).success).toBe(false);
    expect(UpdatePatientSchema.safeParse({ demographics: { ethnicity: "Hispanic" } }).success).toBe(false);
    expect(UpdatePatientSchema.safeParse({ demographics: { preferredLanguage: "Spanish" } }).success).toBe(false);
  });
});
