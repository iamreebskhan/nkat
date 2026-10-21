/**
 * The per-visit ownership boundary.
 *
 * app/api/visits/[id]/route.ts refuses a .own-only caller another clinician's
 * visit; seven sibling routes listed visits.view.own as sufficient and then
 * never asked whose visit it was. These tests pin the rule, pin it at the six
 * reads that take the guard, and pin it at the three WRITES that take it —
 * visits.edit and visits.submit are both in the clinician role template, so
 * neither is an ownership gate and a comment saying otherwise is how the write
 * side stayed open.
 *
 * The five siblings guarded after those — services GET/PUT, document PATCH,
 * vitals PUT and reschedule PATCH — are pinned by handler in
 * visit-write-ownership.spec.ts. What holds them here is the on-disk sweep: no
 * longer being named in KNOWN_REACHABLE, any one of them losing its guard fails
 * this file too.
 *
 * lib/db is mocked with a fake tx, but the fake does not recognise the guard's
 * query by a substring of the guard's own text: it matches the shape built from
 * prisma/schema.prisma's `model Visit`, and rejects anything else loudly.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/hipaa/phi-access-log", () => ({
  logPhiAccess: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
// The handler sweep below drives unguarded handlers into services the fake
// database refuses, on purpose; each lands in handleServiceError, which would
// otherwise print a stack trace per handler. Nothing here asserts on it.
vi.mock("@/lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/sentry")>()),
  reportError: vi.fn(),
}));
vi.mock("@/lib/features/visits/audit-packet.service", () => ({
  getNotePreviewHtml: vi.fn().mockResolvedValue({ html: "<h1>the whole note</h1>" }),
  getVisitReconciliation: vi.fn().mockResolvedValue({ findings: [] }),
  generateAuditPacketPdf: vi
    .fn()
    .mockResolvedValue({ pdfBytes: new Uint8Array([37, 80, 68, 70]), patientId: "p" }),
}));
vi.mock("@/lib/features/visits/note.service", () => ({
  getVisitNote: vi.fn().mockResolvedValue({ sections: [] }),
  saveNoteSection: vi.fn().mockResolvedValue({ sectionKey: "hpi" }),
  getCarryForwardSource: vi.fn(),
  carryForwardSections: vi.fn().mockResolvedValue({ copied: ["hpi"], skipped: [] }),
  // The shape the real getVitalsTrend returns and the shape
  // app/api/patients/[id]/vitals/route.ts destructures: {rows, total}. An array
  // stub left both undefined, the route answered 200 with
  // {trend: undefined, total: undefined}, and the two tests below — which only
  // read the status — passed on a response carrying no trend at all.
  getVitalsTrend: vi.fn().mockResolvedValue({ rows: [{ weightKg: 58 }], total: 61 }),
}));
vi.mock("@/lib/features/visits/addendum.service", () => ({
  ADDENDUM_MAX: 20_000,
  listVisitAddenda: vi.fn().mockResolvedValue([]),
  addVisitAddendum: vi.fn().mockResolvedValue({ id: "ad" }),
}));
// Only for the copy-parity test below: GET /api/visits/[id] is the route this
// whole rule is copied from, so its refusal is read back from the real handler
// rather than restated here.
vi.mock("@/lib/features/visits/visit.service", () => ({ getVisit: vi.fn() }));
// The superbill handlers are swept below and pinned directly at the bottom of
// this file. Their service is stubbed rather than left to the fake database so
// that an UNGUARDED handler answers the way the auditor's probe actually saw it
// answer — 200 carrying the patient id, the subscriber's member id and the
// diagnoses — instead of dying on an unrecognised query and passing for a
// refusal.
vi.mock("@/lib/features/superbills/superbill.service", () => ({
  getSuperbillByVisit: vi.fn().mockResolvedValue(null),
  buildDraftFromVisit: vi.fn(),
  persistDraft: vi.fn().mockResolvedValue({ id: "5b000000-0000-4000-8000-00000000000e" }),
}));

import { type NextRequest } from "next/server";

import { fail } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { addVisitAddendum, listVisitAddenda } from "@/lib/features/visits/addendum.service";
import {
  generateAuditPacketPdf,
  getNotePreviewHtml,
  getVisitReconciliation,
} from "@/lib/features/visits/audit-packet.service";
import {
  carryForwardSections,
  getCarryForwardSource,
  getVisitNote,
  getVitalsTrend,
  saveNoteSection,
} from "@/lib/features/visits/note.service";
import { MemberPermissionsSchema, ROLE_DEFAULT_PERMISSIONS } from "@/lib/features/team/team.types";
import {
  buildDraftFromVisit,
  getSuperbillByVisit,
  persistDraft,
} from "@/lib/features/superbills/superbill.service";
import { getVisit } from "@/lib/features/visits/visit.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

import { GET as visitGet } from "@/app/api/visits/[id]/route";
import {
  GET as addendaGet,
  POST as addendaPost,
} from "@/app/api/visits/[id]/addenda/route";
import { GET as auditPacketGet } from "@/app/api/visits/[id]/audit-packet/route";
import {
  GET as carryForwardGet,
  POST as carryForwardPost,
} from "@/app/api/visits/[id]/carry-forward/route";
import { GET as noteGet, PATCH as notePatch } from "@/app/api/visits/[id]/note/route";
import { GET as notePreviewGet } from "@/app/api/visits/[id]/note-preview/route";
import { GET as reconciliationGet } from "@/app/api/visits/[id]/reconciliation/route";
import {
  GET as superbillGet,
  POST as superbillPost,
} from "@/app/api/visits/[id]/superbill/route";
import { GET as vitalsGet } from "@/app/api/patients/[id]/vitals/route";

import { mayAccessVisit, requireVisitAccess, VIEW_ANY_VISIT } from "../visit-access";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CLINICIAN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VISIT = "e0000000-0000-4000-8000-00000000000a";
/** The previous signed visit carry-forward offers — another clinician's. */
const SOURCE_VISIT = "e0000000-0000-4000-8000-00000000000b";
/** A signed visit of the same patient that was NOT offered. */
const UNOFFERED_VISIT = "e0000000-0000-4000-8000-00000000000d";
const PATIENT = "c0000000-0000-4000-8000-00000000000c";

/**
 * The body GET /api/visits/[id]/superbill hands over on a 200 — named here
 * because what the refusal must NOT contain is the point. The auditor drove the
 * real handler with ["billing.superbills.view"] and got exactly this shape
 * back: the patient id, the subscriber's member id and the ICD-10 codes of a
 * visit belonging to someone else.
 */
const DRAFT = {
  visitId: VISIT,
  patientId: PATIENT,
  memberIdSnapshot: "MEM-12345",
  icd10Codes: ["G30.9"],
  cptCodes: ["99349"],
};

/**
 * The shipped templates themselves, imported rather than retyped.
 *
 * Retyping them is how the write side stayed open: two route comments asserted
 * that a .own-only caller does not hold visits.edit or visits.submit, and the
 * clinician template holds both. A hand-copied subset in here would have agreed
 * with the comments instead of with team.types.ts.
 */
const CLINICIAN = ROLE_DEFAULT_PERMISSIONS.clinician;
/** The .all side of the rule. */
const BILLING_AGENT = ROLE_DEFAULT_PERMISSIONS.billing_agent;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * The table and column the guard must read, taken from the schema rather than
 * retyped from the guard.
 *
 * Matching the query against a string copied out of visit-access.ts only proves
 * the file agrees with itself. It did: the old fake dispatched on
 * sql.includes("SELECT clinician_user_id FROM visit"), and "FROM visits" —
 * the wrong table — contains that substring, so renaming the table left this
 * spec green while every guarded route threw at runtime. The guard sits outside
 * each route's try/catch, so that throw is a 500 with no handleServiceError
 * envelope and no Sentry report.
 */
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

/**
 * The whole query, not a fragment of it: table, column, the parameters'
 * positions, and that it is a single-row lookup by id within the caller's org.
 * The org is named as well as enforced by RLS, so a connection that bypasses
 * RLS still cannot open another org's visit through the guard.
 */
const OWNER_QUERY = new RegExp(
  `^\\s*SELECT\\s+${SCHEMA.column}\\s+FROM\\s+${SCHEMA.table}\\s+WHERE\\s+id\\s*=\\s*¶::uuid\\s+AND\\s+${SCHEMA.org}\\s*=\\s*¶::uuid\\s+LIMIT\\s+1\\s*$`,
  "i",
);

/** Whose visit the fake database holds, or null for "no such row". */
let visitOwner: string | null;

/** A second org. The fake's visit is ORG's, so a session here must not find it. */
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    if (OWNER_QUERY.test(sql)) {
      // Bindings are (id, org): the one visit the fake holds belongs to ORG.
      return Promise.resolve(
        visitOwner && values[1] === ORG ? [{ [SCHEMA.column]: visitOwner }] : [],
      );
    }
    // Loud rather than empty. An unrecognised query answered with [] reads as
    // "no such visit" and turns a broken guard into a plausible 404.
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

/** Routes only forward the request to the (mocked) PHI access log. */
const req = new Request("http://localhost/x") as unknown as NextRequest;
/** A body can only be read once, so each write test builds its own. */
function jsonReq(body: unknown) {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  visitOwner = ME;
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
  vi.mocked(requireAuth).mockResolvedValue(session(CLINICIAN) as never);
  // The source carry-forward offers this visit: the patient's last signed
  // visit, which on real data is routinely another clinician's.
  vi.mocked(getCarryForwardSource).mockResolvedValue({
    visitId: SOURCE_VISIT,
    visitDate: null,
    visitTypeLabel: null,
    sections: [{ sectionKey: "hpi", label: "History" }],
  });
  vi.mocked(getVisit).mockImplementation(
    async () =>
      (visitOwner
        ? { id: VISIT, clinicianUserId: visitOwner, patientId: PATIENT }
        : null) as never,
  );
  vi.mocked(getSuperbillByVisit).mockResolvedValue(null as never);
  vi.mocked(buildDraftFromVisit).mockResolvedValue(DRAFT as never);
  vi.mocked(persistDraft).mockResolvedValue({
    id: "5b000000-0000-4000-8000-00000000000e",
  } as never);
});

describe("mayAccessVisit — the rule app/api/visits/[id]/route.ts has always applied", () => {
  it("rests on a clinician template that holds the write permissions and not visits.view.all", () => {
    // The premise every guard in this package is written against, asserted
    // against the shipped template rather than against a comment. A clinician
    // is admitted to the write handlers by visits.edit and visits.submit, so
    // neither can be read as a claim on a particular visit; visits.view.all is
    // what the caller does NOT have, and is therefore the only thing that may
    // lift the ownership test. Add visits.view.all to this template and the
    // boundary is gone — that should fail a test, not pass quietly.
    expect(CLINICIAN).toContain("visits.view.own");
    expect(CLINICIAN).toContain("visits.edit");
    expect(CLINICIAN).toContain("visits.submit");
    expect(CLINICIAN).not.toContain(VIEW_ANY_VISIT);
  });

  it("lets a .own-only caller at their own visit", () => {
    expect(
      mayAccessVisit({ permissions: CLINICIAN, userId: ME, clinicianUserId: ME }),
    ).toBe(true);
  });

  it("refuses a .own-only caller another clinician's visit", () => {
    expect(
      mayAccessVisit({ permissions: CLINICIAN, userId: ME, clinicianUserId: OTHER_CLINICIAN }),
    ).toBe(false);
  });

  it("lets visits.view.all at anyone's visit", () => {
    expect(
      mayAccessVisit({ permissions: BILLING_AGENT, userId: ME, clinicianUserId: OTHER_CLINICIAN }),
    ).toBe(true);
    expect(VIEW_ANY_VISIT).toBe("visits.view.all");
  });

  it("does not let visits.edit stand in for visits.view.all", () => {
    // The clinician template carries visits.edit next to visits.view.own, so an
    // edit-as-bypass reading would make the whole check a no-op for the one
    // caller it constrains.
    expect(
      mayAccessVisit({
        permissions: ["visits.edit"],
        userId: ME,
        clinicianUserId: OTHER_CLINICIAN,
      }),
    ).toBe(false);
    expect(
      mayAccessVisit({ permissions: ["visits.edit"], userId: ME, clinicianUserId: ME }),
    ).toBe(true);
  });

  it("does not let visits.submit stand in for it either", () => {
    // Same trap on the attestation side: the clinician template holds
    // visits.submit so clinicians can sign their own visits.
    expect(
      mayAccessVisit({
        permissions: ["visits.submit"],
        userId: ME,
        clinicianUserId: OTHER_CLINICIAN,
      }),
    ).toBe(false);
  });
});

describe("requireVisitAccess", () => {
  it("returns null — proceed — for the caller's own visit", async () => {
    expect(
      await requireVisitAccess({ session: session(CLINICIAN), visitId: VISIT }),
    ).toBeNull();
  });

  it("returns 403 'Permission denied' when the visit is another clinician's", async () => {
    visitOwner = OTHER_CLINICIAN;
    const res = await requireVisitAccess({ session: session(CLINICIAN), visitId: VISIT });
    expect(res?.status).toBe(403);
    expect((await res!.json()).error).toBe("Permission denied");
  });

  it("refuses in the same words as GET /api/visits/[id], the route this rule came from", async () => {
    // One clinician, one visit, two URLs, one answer. Without this the two can
    // drift into separate refusal dialects for the identical situation — which
    // is what happened, and what the longer "belongs to another clinician"
    // wording was.
    visitOwner = OTHER_CLINICIAN;
    const fromHelper = await requireVisitAccess({ session: session(CLINICIAN), visitId: VISIT });
    const fromSibling = await visitGet(req, ctx(VISIT));
    expect(fromSibling.status).toBe(403);
    expect(fromHelper?.status).toBe(fromSibling.status);
    expect(await fromHelper!.json()).toEqual(await fromSibling.json());
  });

  it("returns null for visits.view.all whoever the clinician is", async () => {
    visitOwner = OTHER_CLINICIAN;
    expect(
      await requireVisitAccess({ session: session(BILLING_AGENT), visitId: VISIT }),
    ).toBeNull();
  });

  it("answers 404 'Visit not found.' for a row this tenant cannot see", async () => {
    // Same wording as every other visit read, so the refusal cannot be read as
    // confirmation that the row exists in some other org.
    visitOwner = null;
    const res = await requireVisitAccess({ session: session(BILLING_AGENT), visitId: VISIT });
    expect(res?.status).toBe(404);
    expect((await res!.json()).error).toBe("Visit not found.");
  });

  it("answers 404 'Visit not found.' to another org's session, even with visits.view.all", async () => {
    // The visit exists and its clinician is the caller's own user id, so only
    // the org named in the lookup keeps it out. Same wording as a missing row.
    const res = await requireVisitAccess({
      session: { ...session(BILLING_AGENT), orgId: OTHER_ORG },
      visitId: VISIT,
    });
    expect(res?.status).toBe(404);
    expect((await res!.json()).error).toBe("Visit not found.");
  });

  it("reads the table and column prisma/schema.prisma declares", async () => {
    // The assertion the old fake could not make: the SQL is checked against the
    // schema, not against itself.
    let seen = "";
    vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        $queryRaw: (strings: TemplateStringsArray) => {
          seen = strings.join("¶");
          return Promise.resolve([{ [SCHEMA.column]: ME }]);
        },
      }),
    );
    await requireVisitAccess({ session: session(CLINICIAN), visitId: VISIT });
    expect(seen).toMatch(OWNER_QUERY);
  });
});

/**
 * Every per-visit GET that lists visits.view.own as sufficient, paired with the
 * service call it is supposed to be standing in front of. All six take the same
 * two lines from visit-access.ts, so they are asserted as one table. The table
 * is hand-written; the tests under it load every handler in app/api/visits/[id]/
 * and call it, so that a seventh route added without the guard fails here
 * rather than passing unnoticed, however its permissions are written.
 */
const PER_VISIT_ROUTES = [
  { name: "note", run: noteGet, service: getVisitNote, extra: [] as string[] },
  { name: "note-preview", run: notePreviewGet, service: getNotePreviewHtml, extra: [] as string[] },
  { name: "reconciliation", run: reconciliationGet, service: getVisitReconciliation, extra: [] as string[] },
  { name: "addenda", run: addendaGet, service: listVisitAddenda, extra: [] as string[] },
  { name: "carry-forward", run: carryForwardGet, service: getCarryForwardSource, extra: [] as string[] },
  // The packet is the one that also demands a billing permission on top.
  {
    name: "audit-packet",
    run: auditPacketGet,
    service: generateAuditPacketPdf,
    extra: ["billing.superbills.export"],
  },
];

describe.each(PER_VISIT_ROUTES)("GET /api/visits/[id]/$name", ({ run, service, extra }) => {
  it("serves the clinician their own visit", async () => {
    vi.mocked(requireAuth).mockResolvedValue(session([...CLINICIAN, ...extra]) as never);
    expect((await run(req, ctx(VISIT))).status).toBe(200);
    expect(service).toHaveBeenCalled();
  });

  it("refuses another clinician's visit, without reaching the service", async () => {
    visitOwner = OTHER_CLINICIAN;
    vi.mocked(requireAuth).mockResolvedValue(session([...CLINICIAN, ...extra]) as never);
    expect((await run(req, ctx(VISIT))).status).toBe(403);
    expect(service).not.toHaveBeenCalled();
  });

  it("still serves any clinician's visit to visits.view.all", async () => {
    visitOwner = OTHER_CLINICIAN;
    vi.mocked(requireAuth).mockResolvedValue(session([...BILLING_AGENT, ...extra]) as never);
    expect((await run(req, ctx(VISIT))).status).toBe(200);
    expect(service).toHaveBeenCalled();
  });
});

/**
 * Per-visit handlers that a caller without visits.view.all can still reach on
 * another clinician's visit. Each was in that state when this list was written
 * and none is in this package. Naming them means a NEW one fails the sweep
 * below instead of joining them quietly; the check is "nothing outside this
 * list", so guarding any of them keeps it green.
 *
 * services GET/PUT, document PATCH, vitals PUT and reschedule PATCH were on
 * this list and have since taken the guard, so they are off it: each is now
 * held to the ownership rule, and removing that guard makes the sweep below
 * name the handler and go red rather than finding it excused here.
 *
 * superbill GET/POST were excused here too, on the grounds that they are gated
 * on billing.superbills.* and every shipped template holding those also holds
 * visits.view.all. That was a property of the TEMPLATES, not of the route, and
 * the templates are not the only permission sets that exist: /team saves any
 * set an admin ticks, and a member holding exactly ["billing.superbills.view"]
 * — a set MemberPermissionsSchema accepts, asserted below — was answered 200
 * with another clinician's patient id, member id and diagnoses. Both handlers
 * now take requireVisitAccess and are off this list, so losing that guard fails
 * the sweep.
 *
 * What is left is the one deliberate case: transition POST allows a covering
 * signer, and visit.service.ts records signerIsClinicianOfRecord on the audit
 * row rather than refusing — a clinician who signs for a colleague is a real
 * thing that happens, and lib/features/visits/__tests__/sign-requires-note.spec.ts
 * pins the flag by driving the service, both ways round. Refusing here would
 * block cover; dropping the flag would make it untraceable, which is the part
 * that has a test.
 */
const KNOWN_REACHABLE = new Set(["transition POST"]);

/**
 * The widest caller the ownership rule constrains: every permission a shipped
 * template grants, minus the one that lifts the rule. Permission sets are
 * edited per member (PUT /api/team/members/[userId]), so a handler that only a
 * combination of permissions opens is still one somebody can be given.
 */
const WIDEST_WITHOUT_VIEW_ALL = [
  ...new Set(Object.values(ROLE_DEFAULT_PERMISSIONS).flat()),
].filter((p) => p !== VIEW_ANY_VISIT);

const PER_VISIT_DIR = path.join(REPO_ROOT, "app", "api", "visits", "[id]");
const ROUTE_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Every route file at or below app/api/visits/[id]/, nested ones included. */
function perVisitRouteFiles(dir = PER_VISIT_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return perVisitRouteFiles(full);
    return /^route\.[cm]?[jt]sx?$/.test(e.name) ? [full] : [];
  });
}

type HandlerAnswer = number | "threw";

/**
 * Call every exported handler under app/api/visits/[id]/ as
 * WIDEST_WITHOUT_VIEW_ALL, on a visit owned by `owner`, and record the status.
 *
 * Nothing here reads how a route is spelled. The scan this replaced matched
 * '"visits.view.own"' and 'requireAuth(["visits.edit"])' as literal text, so
 * a handler written with single quotes, a shared permission constant or a
 * two-permission gate walked straight past it, and reschedule PATCH, let in by
 * schedule.edit, was never looked at. Calling the handler asks the only thing
 * that matters: does it answer this caller anything but 403?
 *
 * The fake database rejects every query except the guard's, so a handler that
 * gets past the point where it should have refused reaches a service and
 * comes back 500 or throws. Either counts as reached.
 */
async function sweepPerVisitHandlers(owner: string): Promise<Map<string, HandlerAnswer>> {
  visitOwner = owner;
  vi.mocked(requireAuth).mockImplementation(async (required: string[] = []) => {
    // lib/auth.ts's own rule: the caller needs every listed permission.
    const missing = required.filter((p) => !WIDEST_WITHOUT_VIEW_ALL.includes(p));
    return (
      missing.length > 0
        ? fail(`Permission denied: missing ${missing.join(", ")}.`, { status: 403 })
        : session(WIDEST_WITHOUT_VIEW_ALL)
    ) as never;
  });

  const answers = new Map<string, HandlerAnswer>();
  for (const file of perVisitRouteFiles()) {
    const rel = path.relative(PER_VISIT_DIR, path.dirname(file)).split(path.sep).join("/");
    // An import that fails is left to fail the test: a module this spec cannot
    // load is a route it cannot vouch for, not one to skip.
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const method of ROUTE_METHODS) {
      const handler = mod[method];
      if (typeof handler !== "function") continue;
      let answer: HandlerAnswer;
      try {
        // A fresh body per call, and deliberately an empty one: the guarded
        // writes refuse before they parse, so a 422 here means the handler
        // reached its body parser without asking whose visit this is.
        const res = await (handler as (r: NextRequest, c: unknown) => Promise<Response>)(
          jsonReq({}),
          ctx(VISIT),
        );
        answer = res.status;
      } catch {
        answer = "threw";
      }
      answers.set(`${rel || "[id]"} ${method}`, answer);
    }
  }
  return answers;
}

function perVisitRouteSources(): { name: string; src: string }[] {
  const dir = PER_VISIT_DIR;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, file: path.join(dir, e.name, "route.ts") }))
    .filter((e) => fs.existsSync(e.file))
    .map((e) => ({ name: e.name, src: fs.readFileSync(e.file, "utf8") }));
}

/**
 * One entry per exported handler, sliced at the `export async function`
 * boundaries — because "the file mentions requireVisitAccess somewhere" is not
 * the question. A route that guards its GET and not its PATCH is the exact
 * shape of what went wrong here, and at file granularity it reads as guarded.
 */
function handlersOf(src: string): { method: string; body: string }[] {
  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
  const starts: { method: string; at: number }[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) starts.push({ method: m[1], at: m.index });
  return starts.map((s, i) => ({
    method: s.method,
    body: src.slice(s.at, starts[i + 1]?.at ?? src.length),
  }));
}

describe("the routes on disk", () => {
  it("has a table row for a route file whose GET really calls the guard", () => {
    const sources = new Map(perVisitRouteSources().map((r) => [r.name, r.src]));
    for (const { name } of PER_VISIT_ROUTES) {
      const get = handlersOf(sources.get(name) ?? "").find((h) => h.method === "GET");
      expect(get?.body, `app/api/visits/[id]/${name}/route.ts GET`).toContain(
        "requireVisitAccess",
      );
    }
  });

  it("leaves no NEW per-visit handler, read or write, answering another clinician's visit", async () => {
    // Reads and writes alike. The read table above would not have caught the
    // write gap: a route comment claimed visits.edit and visits.submit were
    // themselves the ownership gate, and nothing on disk contradicted it.
    const onTheirs = await sweepPerVisitHandlers(OTHER_CLINICIAN);
    const reached = [...onTheirs]
      .filter(([, answer]) => answer !== 403)
      .map(([key]) => key)
      .filter((key) => !KNOWN_REACHABLE.has(key));
    expect(reached).toEqual([]);
  }, 30_000);

  it("tells ownership apart in that sweep, so its 403s are not vacuous", async () => {
    // A sweep in which every handler said 403 for some other reason — the
    // caller shut out at the door, a guard that refuses everybody — would pass
    // the test above and prove nothing. So the same caller goes to its OWN
    // visit too, and every handler this package guards must refuse only the
    // other clinician's. GET /api/visits/[id] is in the list because it is
    // where the rule came from.
    const onTheirs = await sweepPerVisitHandlers(OTHER_CLINICIAN);
    const onMine = await sweepPerVisitHandlers(ME);
    const refusedForOwnership = [...onTheirs]
      .filter(([key, answer]) => answer === 403 && onMine.get(key) !== 403)
      .map(([key]) => key);
    const guardedHere = [
      "[id] GET",
      ...PER_VISIT_ROUTES.map((r) => `${r.name} GET`),
      ...PER_VISIT_WRITES.map((w) => {
        const [method, url] = w.name.split(" ");
        return `${url.replace("/api/visits/[id]/", "")} ${method}`;
      }),
      // Both superbill handlers now take the guard. They are named here rather
      // than only dropped from KNOWN_REACHABLE so that a guard which refuses
      // EVERYBODY — the cheapest way to make the sweep above pass — fails:
      // these two must answer their own clinician something other than 403.
      "superbill GET",
      "superbill POST",
      // Correcting the visit type before sign-off (it changes the band the
      // visit bills on). Named for the same reason as the superbill pair: a
      // guard that refused everybody would pass the sweep above.
      "visit-type PATCH",
    ];
    expect(guardedHere).toHaveLength(13);
    expect(refusedForOwnership).toEqual(expect.arrayContaining(guardedHere));
  }, 30_000);

  it("gives no shipped template billing.superbills.* without visits.view.all", () => {
    // This used to be what the superbill entries in KNOWN_REACHABLE rested on.
    // With both handlers guarded it protects the opposite direction: the billing
    // agent's whole job is other clinicians' visits, so a template that granted
    // billing.superbills.* WITHOUT visits.view.all would now meet the new guard
    // and 403 on every bill they open.
    for (const [role, perms] of Object.entries(ROLE_DEFAULT_PERMISSIONS)) {
      if (perms.some((p) => p.startsWith("billing.superbills."))) {
        expect(perms, role).toContain(VIEW_ANY_VISIT);
      }
    }
  });
});

/**
 * The write side.
 *
 * These were left unguarded on the premise that visits.edit and visits.submit
 * are permissions a .own-only caller does not hold. The clinician template
 * holds both (CLINICIAN above, which IS that template), so the premise was
 * false and a clinician refused the READ of a colleague's visit
 * could still write into it: note sections, an addendum printed with their own
 * name, or a whole previous note carried forward.
 */
const PER_VISIT_WRITES = [
  {
    name: "PATCH /api/visits/[id]/note",
    ok: 200,
    service: saveNoteSection,
    run: (id: string) => notePatch(jsonReq({ sectionKey: "hpi", content: {} }), ctx(id)),
  },
  {
    name: "POST /api/visits/[id]/addenda",
    ok: 201,
    service: addVisitAddendum,
    run: (id: string) => addendaPost(jsonReq({ body: "corrected the dose" }), ctx(id)),
  },
  {
    name: "POST /api/visits/[id]/carry-forward",
    ok: 200,
    service: carryForwardSections,
    run: (id: string) =>
      carryForwardPost(jsonReq({ fromVisitId: SOURCE_VISIT, sectionKeys: ["hpi"] }), ctx(id)),
  },
];

describe.each(PER_VISIT_WRITES)("$name", ({ ok, service, run }) => {
  it("writes to the clinician's own visit", async () => {
    expect((await run(VISIT)).status).toBe(ok);
    expect(service).toHaveBeenCalled();
  });

  it("refuses another clinician's visit, without reaching the service", async () => {
    visitOwner = OTHER_CLINICIAN;
    const res = await run(VISIT);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, data: null, error: "Permission denied" });
    expect(service).not.toHaveBeenCalled();
  });

  it("still writes to any clinician's visit for visits.view.all", async () => {
    visitOwner = OTHER_CLINICIAN;
    // An org admin: the write permissions plus the .all read.
    vi.mocked(requireAuth).mockResolvedValue(
      session([...CLINICIAN, "visits.view.all"]) as never,
    );
    expect((await run(VISIT)).status).toBe(ok);
    expect(service).toHaveBeenCalled();
  });
});

describe("POST /api/visits/[id]/carry-forward — which source it will take", () => {
  it("copies the source the GET offered, even though another clinician wrote it", async () => {
    // The feature, kept: "you can use that note as a template for the next
    // visit", and the patient's last signed visit is routinely somebody else's.
    const res = await carryForwardPost(
      jsonReq({ fromVisitId: SOURCE_VISIT, sectionKeys: ["hpi"] }),
      ctx(VISIT),
    );
    expect(res.status).toBe(200);
    expect(carryForwardSections).toHaveBeenCalledWith(
      expect.objectContaining({ visitId: VISIT, fromVisitId: SOURCE_VISIT }),
    );
  });

  it("refuses a fromVisitId this visit was not offered", async () => {
    // carryForwardSections accepts ANY signed visit of the same patient, which
    // is wider than the panel driving it — sectioned-note.tsx posts back
    // exactly the id the GET returned. Naming a different one is refused here.
    const res = await carryForwardPost(
      jsonReq({ fromVisitId: UNOFFERED_VISIT, sectionKeys: ["hpi"] }),
      ctx(VISIT),
    );
    expect(res.status).toBe(422);
    expect(carryForwardSections).not.toHaveBeenCalled();
  });

  it("refuses when this visit has nothing to carry forward at all", async () => {
    vi.mocked(getCarryForwardSource).mockResolvedValue(null);
    const res = await carryForwardPost(
      jsonReq({ fromVisitId: SOURCE_VISIT, sectionKeys: ["hpi"] }),
      ctx(VISIT),
    );
    expect(res.status).toBe(422);
    expect(carryForwardSections).not.toHaveBeenCalled();
  });
});

/**
 * The superbill pair, driven directly.
 *
 * The sweep above says "no handler outside KNOWN_REACHABLE answers another
 * clinician's visit"; these say what the refusal looks like and what a 200
 * would otherwise have carried, because "it 403s" and "it does not hand over
 * the patient's member id" are not the same assertion.
 */
describe("/api/visits/[id]/superbill — a billing permission is not a claim on a visit", () => {
  it("is a permission set the member editor accepts, which is why the templates could not carry this", () => {
    // The premise the old exception rested on, checked against the schema that
    // actually decides. /team writes whatever set validates here, so "no
    // shipped template grants billing.superbills.* without visits.view.all"
    // never constrained the route — it constrained the six templates.
    expect(
      MemberPermissionsSchema.safeParse({ permissions: ["billing.superbills.view"] }).success,
    ).toBe(true);
    expect(BILLING_AGENT).toContain("billing.superbills.view");
  });

  it("GET refuses that member another clinician's visit, handing over nothing", async () => {
    visitOwner = OTHER_CLINICIAN;
    vi.mocked(requireAuth).mockResolvedValue(session(["billing.superbills.view"]) as never);
    const res = await superbillGet(req, ctx(VISIT));
    expect(res.status).toBe(403);
    // The whole envelope: the 403 the auditor's probe should have got in place
    // of a body carrying PATIENT, "MEM-12345" and ["G30.9"].
    expect(await res.json()).toEqual({ success: false, data: null, error: "Permission denied" });
    expect(getSuperbillByVisit).not.toHaveBeenCalled();
    expect(buildDraftFromVisit).not.toHaveBeenCalled();
    // §164.528: a disclosure that did not happen must not be logged as one.
    expect(logPhiAccess).not.toHaveBeenCalled();
  });

  it("POST refuses that member another clinician's visit, writing no bill on it", async () => {
    visitOwner = OTHER_CLINICIAN;
    vi.mocked(requireAuth).mockResolvedValue(session(["billing.superbills.create"]) as never);
    const res = await superbillPost(jsonReq({}), ctx(VISIT));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, data: null, error: "Permission denied" });
    // Nor reads the visit's bill, which a POST now hands back when there is one.
    expect(getSuperbillByVisit).not.toHaveBeenCalled();
    expect(buildDraftFromVisit).not.toHaveBeenCalled();
    expect(persistDraft).not.toHaveBeenCalled();
  });

  it("still serves the billing agent any clinician's visit — the whole job", async () => {
    // The guard must not close the feature it sits in front of. A billing agent
    // holds visits.view.all, and the draft comes back in full.
    visitOwner = OTHER_CLINICIAN;
    vi.mocked(requireAuth).mockResolvedValue(session(BILLING_AGENT) as never);
    const res = await superbillGet(req, ctx(VISIT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { existing: null, draft: DRAFT },
      error: null,
    });
  });

  it("still creates the bill for a billing agent on another clinician's visit", async () => {
    visitOwner = OTHER_CLINICIAN;
    vi.mocked(requireAuth).mockResolvedValue(session(BILLING_AGENT) as never);
    const res = await superbillPost(jsonReq({}), ctx(VISIT));
    expect(res.status).toBe(201);
    expect(persistDraft).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, draft: DRAFT, actorUserId: ME }),
    );
  });

  it("serves the clinician of record their own visit on the billing permission alone", async () => {
    // Ownership, not a blanket block: the same hand-built set that is refused
    // above is served on the caller's own visit, exactly as every other
    // per-visit route treats it.
    vi.mocked(requireAuth).mockResolvedValue(session(["billing.superbills.view"]) as never);
    const res = await superbillGet(req, ctx(VISIT));
    expect(res.status).toBe(200);
    expect(buildDraftFromVisit).toHaveBeenCalledWith({ orgId: ORG, visitId: VISIT });
  });

  it("answers 404 for a visit this tenant cannot see, before the service runs", async () => {
    visitOwner = null;
    vi.mocked(requireAuth).mockResolvedValue(session(BILLING_AGENT) as never);
    const res = await superbillGet(req, ctx(VISIT));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Visit not found.");
    expect(getSuperbillByVisit).not.toHaveBeenCalled();
  });
});

describe("GET /api/patients/[id]/vitals", () => {
  it("serves the whole trend to patients.view — every clinician's readings", async () => {
    // Patient-scoped: the curve is only useful complete, so it is NOT filtered
    // to the caller's own visits.
    const res = await vitalsGet(req, ctx(PATIENT));
    expect(res.status).toBe(200);
    // The body, not just the status. `total` is the count of every reading on
    // file and `trend` the capped page of them; the screen says which it is
    // showing from both, so a 200 that carries neither is a broken screen and
    // has to fail here.
    expect(await res.json()).toEqual({
      success: true,
      data: { trend: [{ weightKg: 58 }], total: 61 },
      error: null,
    });
    expect(getVitalsTrend).toHaveBeenCalled();
  });

  it("refuses a caller whose only claim is visits.view.own", async () => {
    // Nobody may read a named patient's clinical readings on the strength of a
    // visit permission alone — GET /api/patients/[id] requires patients.view.
    vi.mocked(requireAuth).mockResolvedValue(session(["visits.view.own", "visits.edit"]) as never);
    const res = await vitalsGet(req, ctx(PATIENT));
    expect(res.status).toBe(403);
    expect(getVitalsTrend).not.toHaveBeenCalled();
  });

  it("still serves visits.view.all", async () => {
    vi.mocked(requireAuth).mockResolvedValue(session(["visits.view.all"]) as never);
    const res = await vitalsGet(req, ctx(PATIENT));
    expect(res.status).toBe(200);
    // Same body as patients.view gets: this permission widens who may ask, not
    // what comes back.
    expect(await res.json()).toEqual({
      success: true,
      data: { trend: [{ weightKg: 58 }], total: 61 },
      error: null,
    });
  });
});
