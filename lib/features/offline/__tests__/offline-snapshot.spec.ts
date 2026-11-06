/**
 * The offline copy's reads (0119): my care-team patients and my own coming
 * visits, each note through the editor's own read, and the copy logged as a
 * PHI export. lib/db is mocked with a fake tx answering by statement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/hipaa/phi-access-log", () => ({ logPhiExport: vi.fn(async () => undefined) }));
vi.mock("@/lib/features/visits/note.service", () => ({ getVisitNote: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { getVisitNote } from "@/lib/features/visits/note.service";
import { logPhiExport } from "@/lib/hipaa/phi-access-log";

import { getOfflineSnapshot } from "../offline-snapshot.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "d0000000-0000-4000-8000-000000000101";
const RUTH = "2fa44a8a-4b23-41a1-9768-18e1e849d10c";
const VISIT = "c21b0626-37be-4c6f-9ca1-e1163aa6b84d";

let calls: { sql: string; values: unknown[] }[];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT timezone FROM org")) return Promise.resolve([{ timezone: "America/New_York" }]);
    if (sql.includes("FROM app_user WHERE id")) return Promise.resolve([{ name: "Helen Okafor" }]);
    if (sql.includes("FROM visit v") && sql.includes("v.clinician_user_id = ")) {
      return Promise.resolve([
        { id: VISIT, patient_id: RUTH, patient_name: "Ruth Testcase", type: "Established patient — home", at: new Date("2026-10-29T14:00:00Z"), status: "scheduled" },
      ]);
    }
    if (sql.includes("FROM patient p") && sql.includes("no_known_allergies")) {
      return Promise.resolve([
        {
          id: RUTH, name: "Ruth Testcase", date_of_birth: "1941-05-12", sex: "F", phone: null, address_line_1: "12 Elm St",
          address_line_2: null, city: "Columbus", state: "OH", zip: "43215", acuity: "high", dx_code: "C34.90",
          dx_description: "Malignant neoplasm of lung", referral_reason: null, payer_name: "CareSource Ohio",
          no_known_allergies: false, np_name: "Helen Okafor", rn_name: null, sw_name: null, ch_name: "Ruth Amos",
        },
      ]);
    }
    if (sql.includes("FROM care_plan")) {
      return Promise.resolve([
        { patient_id: RUTH, goals: ["Comfort at home"], symptoms: [], interventions: [{ item: "Fan at night", by: "nursing" }],
          monitoring: [{ item: "Pain", everyDays: 7, how: "phone" }],
          // One rule that parses and one that no longer does: the second is skipped.
          escalation: [{ measure: "pain", threshold: 7 }, { measure: "pain", threshold: 99 }], review_on: null },
      ]);
    }
    if (sql.includes("visit_note_section s")) {
      return Promise.resolve([
        { patient_id: RUTH, day: "2026-10-27", type: "New patient — home", clinician: "Helen Okafor",
          ap: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Morphine IR PRN." }] }] } },
      ]);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
  vi.mocked(getVisitNote).mockResolvedValue({
    templateId: "t", templateName: "Palliative visit note", templateVersion: 1, missingRequired: [],
    sections: [
      { sectionKey: "hpi", label: "History of present illness", helpText: null, kind: "prose", isRequired: true, sortOrder: 1,
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Worse at night." }] }] },
        isEmpty: false, carriedFromVisitId: null, carriedUnchanged: false, updatedAt: "2026-10-28T22:29:55.299Z" },
      { sectionKey: "vitals", label: "Vitals", helpText: null, kind: "vitals", isRequired: true, sortOrder: 2,
        content: null, isEmpty: true, carriedFromVisitId: null, carriedUnchanged: false, updatedAt: null },
      { sectionKey: "medications", label: "Medications", helpText: null, kind: "list", isRequired: false, sortOrder: 3,
        content: { items: ["Morphine IR 5 mg"] }, isEmpty: false, carriedFromVisitId: null, carriedUnchanged: false, updatedAt: null },
    ],
    vitals: null,
  });
});

const run = () => getOfflineSnapshot({ orgId: ORG, userId: ME, now: new Date("2026-10-28T21:00:00Z") });
const statement = (fragment: string) => calls.find((c) => c.sql.includes(fragment))!;

describe("getOfflineSnapshot", () => {
  it("takes my own visits still to be written, yesterday to a week ahead in the practice's days, never a PCM/CCM month", async () => {
    await run();
    const v = statement("v.clinician_user_id = ");
    expect(v.values).toEqual(expect.arrayContaining([ORG, ME, "pcm_ccm_month", "2026-10-27", "2026-11-04"]));
    expect(v.sql).toContain("(v.status = 'scheduled' OR v.status = 'in_progress')");
    expect(v.sql).toContain("p.status <> 'archived'");
  });

  it("takes the patients whose clinical care team I am on, and those of my visits; archived charts never", async () => {
    await run();
    const p = statement("no_known_allergies");
    expect(p.sql).toMatch(/IN \(p\.primary_np_user_id, p\.rn_user_id, p\.social_worker_user_id, p\.chaplain_user_id\)/);
    // CONTROL: the billing seat is not a clinical one.
    expect(p.sql).not.toContain("billing_agent_user_id");
    expect(p.values).toContainEqual([RUTH]);
  });

  it("names the org in every statement", async () => {
    await run();
    for (const c of calls.filter((x) => !x.sql.includes("SELECT timezone FROM org") && !x.sql.includes("FROM app_user WHERE id"))) {
      expect(c.values, c.sql.slice(0, 60)).toContain(ORG);
    }
  });

  it("carries each note's sections as text with their versions, the vitals apart, and the chart a home visit needs", async () => {
    const s = await run();
    expect(getVisitNote).toHaveBeenCalledWith({ orgId: ORG, visitId: VISIT });
    expect(s.visits[0]).toMatchObject({ id: VISIT, when: "2026-10-29 10:00 EDT", status: "scheduled" });
    expect(s.visits[0]!.sections).toEqual([
      expect.objectContaining({ sectionKey: "hpi", text: "Worse at night.", updatedAt: "2026-10-28T22:29:55.299Z" }),
      expect.objectContaining({ sectionKey: "medications", kind: "list", text: "Morphine IR 5 mg", updatedAt: null }),
    ]);
    expect(s.visits[0]!.vitals).toMatchObject({ recordedAt: null, values: { painScore: null, bpSystolic: null } });
    expect(s.patients[0]).toMatchObject({
      name: "Ruth Testcase", address: "12 Elm St, Columbus OH 43215", primaryDiagnosis: "C34.90 Malignant neoplasm of lung",
      careTeam: [{ role: "Primary NP", name: "Helen Okafor" }, { role: "Chaplain", name: "Ruth Amos" }],
      carePlan: { goals: ["Comfort at home"], interventions: ["Fan at night"], monitoring: ["Pain, every 7 days"], escalation: ["Pain at or above 7/10"] },
      recentVisits: [{ day: "2026-10-27", assessmentAndPlan: "Morphine IR PRN." }],
    });
    expect(s).toMatchObject({ user: { id: ME, name: "Helen Okafor" }, practiceToday: "2026-10-28", version: 1 });
    // The practice's zone travels with the copy: offline, the page cannot ask for it.
    expect(s.timeZone).toBe("America/New_York");
  });

  it("logs the copy as a PHI export, with every patient in it", async () => {
    const s = await run();
    expect(logPhiExport).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, userId: ME, exportType: "offline_snapshot", patientIds: [RUTH], byteSize: Buffer.byteLength(JSON.stringify(s)) }),
    );
  });
});
