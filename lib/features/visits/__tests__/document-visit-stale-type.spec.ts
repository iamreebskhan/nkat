/**
 * A document screen still coding on a visit type that has since been changed.
 *
 * The screen works its codes out from the type it loaded. When the type is
 * corrected somewhere else — a second tab, or an org admin fixing a
 * clinician's visit while the clinician has it open — that screen keeps
 * suggesting the old band's code, and its Save draft wrote it: documentVisit
 * took the codes with no idea which type they were for. "Sign + submit" saves
 * first, so the bill then carried 99349 on a visit typed new_patient_home,
 * beside an audit row saying the codes had been cleared.
 *
 * The screen now says which type it coded against, and documentVisit refuses
 * the save when that is no longer the visit's type. Run end to end: the real
 * PATCH /api/visits/[id]/document handler, its real schema and the real
 * documentVisit, with lib/db handing over sql-fake's transaction. The type
 * change itself is the real changeVisitType.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));

import { type NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { ROLE_DEFAULT_PERMISSIONS } from "@/lib/features/team/team.types";
import { fakeTx, type FakeDb, type SqlRow } from "@/lib/features/team/__tests__/sql-fake";

import { PATCH as documentPatch } from "@/app/api/visits/[id]/document/route";

import { changeVisitType } from "../visit.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const CLINICIAN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIENT = "f0000000-0000-4000-8000-000000000001";
const VISIT = "e0000000-0000-4000-8000-00000000000a";

const type = (slug: string, label: string, coding_basis: string): SqlRow => ({
  org_id: ORG, slug, label, coding_basis, is_telehealth: false, active: true,
});

let db: FakeDb;

beforeEach(() => {
  const at = new Date("2026-09-20T00:00:00.000Z");
  db = {
    visit: {
      columns: [
        "id", "org_id", "patient_id", "clinician_user_id", "visit_type", "start_time", "stop_time",
        "total_minutes", "acp_minutes", "prolonged_minutes", "document_text", "note_template_id",
        "cpt_codes_assigned", "cpt_units", "icd10_codes", "modifiers", "is_telehealth",
        "telehealth_modality", "telehealth_consent_documented", "place_of_service_code", "status",
        "updated_at",
      ],
      rows: [{
        id: VISIT, org_id: ORG, patient_id: PATIENT, clinician_user_id: CLINICIAN,
        visit_type: "established_patient_home",
        start_time: new Date("2026-09-25T14:00:00.000Z"), stop_time: new Date("2026-09-25T14:45:00.000Z"),
        total_minutes: 45, acp_minutes: 0, prolonged_minutes: 0, document_text: null, note_template_id: null,
        cpt_codes_assigned: ["99349"], cpt_units: {}, icd10_codes: ["C34.90"], modifiers: [],
        is_telehealth: false, telehealth_modality: null, telehealth_consent_documented: false,
        place_of_service_code: "12", status: "in_progress", updated_at: at,
      }],
    },
    org_visit_type: {
      columns: ["org_id", "slug", "label", "coding_basis", "is_telehealth", "active"],
      rows: [
        type("new_patient_home", "New patient — home", "new_patient_home"),
        type("established_patient_home", "Established patient — home", "established_patient_home"),
      ],
    },
    pos: { columns: ["pos", "expiration_date"], rows: [{ pos: "12", expiration_date: null }] },
    audit_log: {
      columns: ["org_id", "user_id", "action", "target_type", "target_id", "payload", "ip_address", "user_agent"],
      rows: [],
    },
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (t: unknown) => Promise<unknown>)(fakeTx(db)),
  );
  // The visit's own clinician, holding the shipped clinician template.
  vi.mocked(requireAuth).mockResolvedValue({
    userId: CLINICIAN,
    orgId: ORG,
    permissions: [...ROLE_DEFAULT_PERMISSIONS.clinician],
    role: "clinician",
    email: "priya@example.test",
  } as never);
});

const row = () => db.visit!.rows[0]!;

/** What the document screen's Save draft sends, coded for `visitType`. */
function saveDraft(visitType: string | undefined, codes: string[]) {
  const body = {
    startTime: "2026-09-25T14:00:00.000Z",
    stopTime: "2026-09-25T14:45:00.000Z",
    totalMinutes: 45,
    acpMinutes: 0,
    cptCodesAssigned: codes,
    cptUnits: {},
    modifiers: [],
    icd10Codes: ["C34.90"],
    isTelehealth: false,
    telehealthConsentDocumented: false,
    placeOfServiceCode: "12",
    ...(visitType === undefined ? {} : { visitType }),
  };
  const req = new Request("http://localhost/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return documentPatch(req, { params: Promise.resolve({ id: VISIT }) });
}

describe("Save draft from a screen coded on a type that has since changed", () => {
  it("is refused, and the codes the change cleared stay cleared", async () => {
    // The admin corrects the type while the clinician's screen is open on the
    // established band, suggesting 99349.
    await changeVisitType({ orgId: ORG, id: VISIT, visitType: "new_patient_home", actorUserId: ADMIN });
    expect(row()).toMatchObject({ visit_type: "new_patient_home", cpt_codes_assigned: [] });

    const res = await saveDraft("established_patient_home", ["99349"]);
    expect(res.status).toBe(422);
    const out = (await res.json()) as { success: boolean; error: string };
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/type was changed after this screen loaded it/);
    expect(out.error).toMatch(/reload the page/);
    expect(row()).toMatchObject({ visit_type: "new_patient_home", cpt_codes_assigned: [] });
  });

  it("CONTROL — a screen coded on the visit's current type saves its codes", async () => {
    await changeVisitType({ orgId: ORG, id: VISIT, visitType: "new_patient_home", actorUserId: ADMIN });
    const res = await saveDraft("new_patient_home", ["99342"]);
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ visit_type: "new_patient_home", cpt_codes_assigned: ["99342"], status: "in_progress" });
  });

  it("a caller that does not say which type it coded for is not checked", async () => {
    // The scripts PATCH codes with no visitType; they are left as they were.
    const res = await saveDraft(undefined, ["99350"]);
    expect(res.status).toBe(200);
    expect(row().cpt_codes_assigned).toEqual(["99350"]);
  });
});
