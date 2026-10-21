/**
 * The per-visit ownership boundary on the five handlers that took the guard
 * after visit-access.spec.ts was written: services GET and PUT, document PATCH,
 * vitals PUT and reschedule PATCH. visit-type PATCH, which corrects the coding
 * band before sign-off, was written with the guard and is held to it here too.
 *
 * Each was reachable by a caller holding only visits.view.own, on another
 * clinician's visit, because the permission that let them in is one the
 * clinician role template already carries:
 *
 *   - visits.edit opens document PATCH, vitals PUT and services PUT. It sits
 *     next to visits.view.own in ROLE_DEFAULT_PERMISSIONS.clinician, so it
 *     admits precisely the caller the boundary exists to constrain.
 *   - schedule.edit opens reschedule PATCH, and the template holds it "so they
 *     can move their own visits on the week grid" — own being the word a
 *     permission cannot enforce by itself. rescheduleVisit UPDATEs on id, org
 *     and status, never on clinician.
 *   - services GET takes any of visits.edit / visits.view.own / visits.view.all.
 *
 * So the routes answered on whatever visit id they were handed, and none of the
 * four services underneath (rescheduleVisit, documentVisit, saveVitals,
 * setVisitServices) looks at clinician_user_id — each checks status at most.
 *
 * These tests call the REAL exported handlers. The service each one fronts is
 * mocked so that "reached the service" and "was refused before it" are separate,
 * observable facts rather than two shades of an error status.
 *
 * lib/db is mocked with a fake tx that recognises the guard's owner lookup by
 * the table and column prisma/schema.prisma declares, not by a string copied
 * out of visit-access.ts — matching the guard against itself proves only that
 * the file agrees with itself.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/features/visits/visit.service", () => ({
  rescheduleVisit: vi.fn(),
  documentVisit: vi.fn(),
  changeVisitType: vi.fn(),
  // The reschedule route's conflict and capacity checks read the visit first.
  // Not found here, so they stand aside: ownership is what this file pins
  // (reschedule-route.spec.ts holds the checks themselves).
  getVisit: vi.fn().mockResolvedValue(null),
  getDailyCapacityStatus: vi.fn(),
  endAfterMove: vi.fn(),
}));
vi.mock("@/lib/features/calendar/google-calendar.service", () => ({
  getBusyForClinician: vi.fn(),
  pushVisitToGoogle: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/features/visits/note.service", () => ({ saveVitals: vi.fn() }));
// Only the two service calls are replaced. SetVisitServicesSchema comes from the
// real module on purpose: the "refused before the body is parsed" tests below
// need the shipped schema to be the thing that would have rejected the body.
vi.mock("@/lib/features/visits/visit-services.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/features/visits/visit-services.service")>()),
  listVisitServices: vi.fn(),
  setVisitServices: vi.fn(),
}));

import { type NextRequest } from "next/server";

import { fail } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { ROLE_DEFAULT_PERMISSIONS } from "@/lib/features/team/team.types";
import { saveVitals } from "@/lib/features/visits/note.service";
import {
  changeVisitType,
  documentVisit,
  rescheduleVisit,
} from "@/lib/features/visits/visit.service";
import {
  listVisitServices,
  setVisitServices,
} from "@/lib/features/visits/visit-services.service";

import { PATCH as documentPatch } from "@/app/api/visits/[id]/document/route";
import { PATCH as reschedulePatch } from "@/app/api/visits/[id]/reschedule/route";
import {
  GET as servicesGet,
  PUT as servicesPut,
} from "@/app/api/visits/[id]/services/route";
import { PATCH as visitTypePatch } from "@/app/api/visits/[id]/visit-type/route";
import { PUT as vitalsPut } from "@/app/api/visits/[id]/vitals/route";

import { VIEW_ANY_VISIT } from "../visit-access";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CLINICIAN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VISIT = "e0000000-0000-4000-8000-00000000000a";
const SERVICE_ID = "f0000000-0000-4000-8000-00000000000e";

/** The shipped templates, imported rather than retyped. */
const CLINICIAN = ROLE_DEFAULT_PERMISSIONS.clinician;
const BILLING_AGENT = ROLE_DEFAULT_PERMISSIONS.billing_agent;
/** An org admin: the clinician's write permissions plus the .all read. */
const WITH_VIEW_ALL = [...CLINICIAN, VIEW_ANY_VISIT];

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** Table, owner column and org column, taken from the schema rather than from the guard. */
function visitOwnerColumnFromSchema(): { table: string; column: string; org: string } {
  const schema = fs.readFileSync(path.join(REPO_ROOT, "prisma", "schema.prisma"), "utf8");
  const model = /model\s+Visit\s*\{([\s\S]*?)\n\}/.exec(schema);
  if (!model) throw new Error("prisma/schema.prisma no longer has a `model Visit` block");
  const table = /@@map\("([^"]+)"\)/.exec(model[1]);
  const column = /clinicianUserId\s+String\s+@map\("([^"]+)"\)/.exec(model[1]);
  const org = /orgId\s+String\s+@map\("([^"]+)"\)/.exec(model[1]);
  if (!table || !column || !org) {
    throw new Error("model Visit no longer declares @@map, clinicianUserId @map and orgId @map");
  }
  return { table: table[1], column: column[1], org: org[1] };
}

const SCHEMA = visitOwnerColumnFromSchema();

/** A lookup by id within the caller's org, as visit-access.spec.ts pins it. */
const OWNER_QUERY = new RegExp(
  `^\\s*SELECT\\s+${SCHEMA.column}\\s+FROM\\s+${SCHEMA.table}\\s+WHERE\\s+id\\s*=\\s*¶::uuid\\s+AND\\s+${SCHEMA.org}\\s*=\\s*¶::uuid\\s+LIMIT\\s+1\\s*$`,
  "i",
);

/** Whose visit the fake database holds, or null for "no such row". */
let visitOwner: string | null;

function fakeTx() {
  const run = (strings: TemplateStringsArray) => {
    const sql = strings.join("¶");
    if (OWNER_QUERY.test(sql)) {
      return Promise.resolve(visitOwner ? [{ [SCHEMA.column]: visitOwner }] : []);
    }
    // Loud rather than empty: an unrecognised query answered with [] reads as
    // "no such visit" and would turn a broken guard into a plausible 404.
    return Promise.reject(
      new Error(
        `fakeTx does not recognise this query — is the guard still reading ` +
          `${SCHEMA.table}.${SCHEMA.column} as prisma/schema.prisma declares it?\n${sql}`,
      ),
    );
  };
  return { $queryRaw: run, $executeRaw: run };
}

function session(permissions: string[]) {
  return { userId: ME, orgId: ORG, permissions, role: "clinician", email: "me@example.test" };
}

/**
 * requireAuth with its own rule applied, not stubbed away: the caller needs
 * every permission the handler lists. Without this a test could "prove" that a
 * billing agent reaches reschedule PATCH, which no shipped template does — the
 * billing_agent template has no schedule.edit.
 */
function signInAs(permissions: string[]) {
  vi.mocked(requireAuth).mockImplementation(async (required: string[] = []) => {
    const missing = required.filter((p) => !permissions.includes(p));
    return (
      missing.length > 0
        ? fail(`Permission denied: missing ${missing.join(", ")}.`, { status: 403 })
        : session(permissions)
    ) as never;
  });
}

/** A body can only be read once, so every call builds its own request. */
function jsonReq(body: unknown) {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
const plainReq = new Request("http://localhost/x") as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  visitOwner = ME;
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
  signInAs(CLINICIAN);
  vi.mocked(rescheduleVisit).mockResolvedValue({ updated: true });
  vi.mocked(documentVisit).mockResolvedValue({ updated: true });
  vi.mocked(saveVitals).mockResolvedValue({ updated: true });
  vi.mocked(listVisitServices).mockResolvedValue([]);
  vi.mocked(setVisitServices).mockResolvedValue({ count: 1 });
  vi.mocked(changeVisitType).mockResolvedValue({
    changed: true,
    codesCleared: true,
    fromBasis: "established_patient_home",
    toBasis: "new_patient_home",
  });
});

/**
 * One row per newly guarded handler.
 *
 * `bad` is a body the handler's own schema rejects, used to prove the guard
 * runs BEFORE the body parser: a caller who may not touch this visit should not
 * be told, by a 422, which of their fields would have been accepted. The
 * services GET has no body, so it has no `bad`.
 */
interface GuardedHandler {
  name: string;
  ok: number;
  /** The mock standing in for the service this handler fronts. */
  service: Mock;
  run: (id: string, body?: unknown) => Promise<Response>;
  bad: Record<string, unknown> | null;
}

const GUARDED: GuardedHandler[] = [
  {
    name: "PATCH /api/visits/[id]/reschedule",
    ok: 200,
    service: vi.mocked(rescheduleVisit) as unknown as Mock,
    run: (id, body) =>
      reschedulePatch(jsonReq(body ?? { scheduledStart: "2026-09-18T14:00:00.000Z" }), ctx(id)),
    bad: { scheduledStart: "thursday-ish" },
  },
  {
    name: "PATCH /api/visits/[id]/document",
    ok: 200,
    service: vi.mocked(documentVisit) as unknown as Mock,
    run: (id, body) =>
      documentPatch(jsonReq(body ?? { documentText: "Seen at home; comfortable." }), ctx(id)),
    // totalMinutes is capped at 720 by DocumentVisitSchema.
    bad: { totalMinutes: 99_999 },
  },
  {
    name: "PUT /api/visits/[id]/vitals",
    ok: 200,
    service: vi.mocked(saveVitals) as unknown as Mock,
    run: (id, body) => vitalsPut(jsonReq(body ?? { weightKg: 58 }), ctx(id)),
    // weightKg is capped at 500 kg, mirroring the CHECK constraint in 0088.
    bad: { weightKg: 9_999 },
  },
  {
    name: "GET /api/visits/[id]/services",
    ok: 200,
    service: vi.mocked(listVisitServices) as unknown as Mock,
    run: (id) => servicesGet(plainReq, ctx(id)),
    bad: null,
  },
  {
    name: "PUT /api/visits/[id]/services",
    ok: 200,
    service: vi.mocked(setVisitServices) as unknown as Mock,
    run: (id, body) =>
      servicesPut(jsonReq(body ?? { services: [{ serviceId: SERVICE_ID, minutes: 20 }] }), ctx(id)),
    // `services` is required, so an empty object never reaches setVisitServices.
    bad: {},
  },
  {
    // Changes the band the visit bills on and clears the codes saved under the
    // old one. visits.edit lets the clinician template in, so the guard is the
    // only thing keeping one clinician off a colleague's claim.
    name: "PATCH /api/visits/[id]/visit-type",
    ok: 200,
    service: vi.mocked(changeVisitType) as unknown as Mock,
    run: (id, body) => visitTypePatch(jsonReq(body ?? { visitType: "new_patient_home" }), ctx(id)),
    // ChangeVisitTypeSchema wants a slug of 2 to 64 characters.
    bad: { visitType: "x" },
  },
];

describe.each(GUARDED)("$name", ({ ok, service, run, bad }) => {
  it("refuses another clinician's visit, without reaching the service", async () => {
    visitOwner = OTHER_CLINICIAN;
    const res = await run(VISIT);
    expect(res.status).toBe(403);
    // The same words GET /api/visits/[id] uses, so one clinician meeting one
    // visit through two URLs is told one thing.
    expect(await res.json()).toEqual({
      success: false,
      data: null,
      error: "Permission denied",
    });
    // The point of the guard: nothing was read and nothing was written.
    expect(service).not.toHaveBeenCalled();
  });

  it("CONTROL — the same caller reaches the service on their OWN visit", async () => {
    // Without this the test above would pass just as well against a handler
    // that refuses everybody, and the clinician's own screens would be broken.
    const res = await run(VISIT);
    expect(res.status).toBe(ok);
    expect(service).toHaveBeenCalled();
  });

  it("still reaches the service on anyone's visit for visits.view.all", async () => {
    visitOwner = OTHER_CLINICIAN;
    signInAs(WITH_VIEW_ALL);
    const res = await run(VISIT);
    expect(res.status).toBe(ok);
    expect(service).toHaveBeenCalled();
  });

  it("answers 404 for a visit this tenant cannot see, without reaching the service", async () => {
    visitOwner = null;
    const res = await run(VISIT);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Visit not found.");
    expect(service).not.toHaveBeenCalled();
  });

  if (bad) {
    it("refuses another clinician's visit before it parses the body", async () => {
      visitOwner = OTHER_CLINICIAN;
      const res = await run(VISIT, bad);
      // 403, not 422: a refused caller is not told whether the body they sent
      // was well formed, which is a fact about the visit's schema they are not
      // entitled to probe for.
      expect(res.status).toBe(403);
      expect(service).not.toHaveBeenCalled();
    });

    it("CONTROL — that same body is what the schema rejects on their own visit", async () => {
      // Proves the 403 above displaced a real 422 rather than agreeing with it.
      const res = await run(VISIT, bad);
      expect(res.status).toBe(422);
      expect(service).not.toHaveBeenCalled();
    });
  }
});

describe("PATCH /api/visits/[id]/reschedule — schedule.edit is not an ownership gate", () => {
  it("is a permission the clinician template grants, so the guard is the only thing narrowing it", () => {
    // The premise the guard rests on, asserted against the shipped template
    // rather than against a route comment. If schedule.edit ever left the
    // clinician template this test should fail and be re-read, not silently
    // make the guard redundant.
    expect(CLINICIAN).toContain("schedule.edit");
    expect(CLINICIAN).not.toContain(VIEW_ANY_VISIT);
  });

  it("keeps the 'not reschedulable' answer for the caller's own already-started visit", async () => {
    // The guard's 404 is for a visit that is not this caller's to see. A visit
    // that IS theirs but has already left 'scheduled' must still get the older,
    // more specific message — rescheduleVisit's UPDATE matches no row and the
    // route says so.
    vi.mocked(rescheduleVisit).mockResolvedValue({ updated: false });
    const res = await reschedulePatch(
      jsonReq({ scheduledStart: "2026-09-18T14:00:00.000Z" }),
      ctx(VISIT),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Visit not found or not reschedulable.");
  });

  it("hands the service the caller's org, the visit and the new time, and records who moved it", async () => {
    // The service writes the visit_reschedule audit row, so it has to be told
    // who the caller is; the route is the only place that knows.
    const res = await reschedulePatch(
      jsonReq({ scheduledStart: "2026-09-18T14:00:00.000Z" }),
      ctx(VISIT),
    );
    expect(res.status).toBe(200);
    expect(rescheduleVisit).toHaveBeenCalledWith({
      orgId: ORG,
      id: VISIT,
      scheduledStart: "2026-09-18T14:00:00.000Z",
      actorUserId: ME,
    });
    // A body with no end is not a request to clear it: the service keeps the
    // visit's own length. The route used to send null here, which erased the
    // end on every drag.
    expect(vi.mocked(rescheduleVisit).mock.calls[0]![0].scheduledEnd).toBeUndefined();
  });

  it.each([
    ["an end", "2026-09-18T15:00:00.000Z"],
    ["null", null],
  ])("passes %s sent for the end through to the service as sent", async (_w, end) => {
    const res = await reschedulePatch(
      jsonReq({ scheduledStart: "2026-09-18T14:00:00.000Z", scheduledEnd: end }),
      ctx(VISIT),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(rescheduleVisit).mock.calls[0]![0].scheduledEnd).toBe(end);
  });
});

describe("PATCH /api/visits/[id]/visit-type — who may correct the type", () => {
  it("hands the service the caller's org, the visit and the slug, and records who did it", async () => {
    const res = await visitTypePatch(jsonReq({ visitType: "  new_patient_home " }), ctx(VISIT));
    expect(res.status).toBe(200);
    expect(changeVisitType).toHaveBeenCalledWith({
      orgId: ORG,
      id: VISIT,
      visitType: "new_patient_home",
      actorUserId: ME,
    });
  });

  it("refuses a billing agent, who holds visits.view.all but not visits.edit", async () => {
    // The agent can open any visit, so the ownership guard would let them
    // through. The permission is what keeps the coding band in the hands of
    // someone who documents; billing corrects codes on the bill instead.
    visitOwner = OTHER_CLINICIAN;
    signInAs(BILLING_AGENT);
    const res = await visitTypePatch(jsonReq({ visitType: "new_patient_home" }), ctx(VISIT));
    expect(res.status).toBe(403);
    expect(changeVisitType).not.toHaveBeenCalled();
  });
});

describe("GET /api/visits/[id]/services — the billing read still works", () => {
  it("serves a billing agent any clinician's visit", async () => {
    // A billing agent reads the services off a visit they did not conduct —
    // this route is fetched for any visit they are working a bill for, not
    // only their own. The billing_agent template holds visits.view.all,
    // so the guard lets them through — this is the case that would have been
    // broken by narrowing the route to the caller's own visits instead.
    visitOwner = OTHER_CLINICIAN;
    signInAs(BILLING_AGENT);
    const res = await servicesGet(plainReq, ctx(VISIT));
    expect(res.status).toBe(200);
    expect(listVisitServices).toHaveBeenCalledWith({ orgId: ORG, visitId: VISIT });
  });

  it("does not let a clinician read a colleague's visit on visits.edit alone", async () => {
    // visits.edit is in READ_ANY, so it is a way IN to this handler. It is not
    // a claim on a particular visit.
    visitOwner = OTHER_CLINICIAN;
    signInAs(["visits.edit"]);
    expect((await servicesGet(plainReq, ctx(VISIT))).status).toBe(403);
    expect(listVisitServices).not.toHaveBeenCalled();
  });
});
