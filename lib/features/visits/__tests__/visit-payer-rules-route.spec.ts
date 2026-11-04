/**
 * POST /api/visits/[id]/payer-rules — the documentation screen's payer rules.
 *
 * The panel used POST /api/billing/lookup, which needs billing.lookup.view.
 * The clinician role template holds no billing.* permission, so every
 * clinician's lookup was refused (seen on localhost on 3 Nov 2026, as Marcus
 * Delgado, NP: 403, and the panel stuck on "checking…"). This route answers the
 * same lookup for a visit the caller may open, with the payer, the coverage
 * state and the date of service read from the visit.
 *
 * The REAL handler and the REAL visit-access guard run; the lookup itself is
 * mocked, so what reaches it is observable. lib/db is a fake tx that answers
 * only the statements it recognises and fails loudly on anything else.
 */
import { type NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/features/billing/rule-lookup.service", () => ({ lookupRule: vi.fn() }));
vi.mock("@/lib/features/billing/synthesized-rule.service", () => ({ persistSynthesizedRule: vi.fn() }));

import { POST as billingLookup } from "@/app/api/billing/lookup/route";
import { POST } from "@/app/api/visits/[id]/payer-rules/route";
import { fail } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { lookupRule } from "@/lib/features/billing/rule-lookup.service";
import { persistSynthesizedRule } from "@/lib/features/billing/synthesized-rule.service";
import { ROLE_DEFAULT_PERMISSIONS } from "@/lib/features/team/team.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CLINICIAN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VISIT = "d3a1d68e-aee7-4955-8bb2-f45467d9db1a";
const MEDICARE = "a0000000-0000-4000-8000-000000000401";

/** Who owns the visit, whether the caller sits on the patient's care team, and the coverage row. */
let owner: string | null;
let onCareTeam: boolean;
let coverage: { payer_id: string | null; state: string | null; at: Date | null; org_timezone: string | null };

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶").replace(/\s+/g, " ");
    if (/^ ?SELECT clinician_user_id FROM visit WHERE id = ¶::uuid AND org_id = ¶::uuid LIMIT 1 ?$/.test(sql)) {
      return Promise.resolve(owner ? [{ clinician_user_id: owner }] : []);
    }
    if (/AS ok FROM visit v JOIN patient p/.test(sql)) return Promise.resolve([{ ok: onCareTeam }]);
    if (/primary_payer_id AS payer_id\b.*FROM visit v\b.*JOIN org o ON o\.id = v\.org_id/.test(sql)) {
      // Scoped to this visit in the caller's org, by bind — not by RLS alone.
      expect(values).toEqual([VISIT, ORG]);
      return Promise.resolve([coverage]);
    }
    return Promise.reject(new Error(`the fake does not recognise this query: ${sql}`));
  };
  return { $queryRaw: run, $executeRaw: run };
}

/** requireAuth with its own rule applied: every listed permission is needed. */
function signInAs(permissions: string[]) {
  vi.mocked(requireAuth).mockImplementation(async (required: string[] = []) => {
    const missing = required.filter((p) => !permissions.includes(p));
    return (
      missing.length > 0
        ? fail(`Permission denied: missing ${missing.join(", ")}.`, { status: 403 })
        : { userId: ME, orgId: ORG, permissions, role: "clinician", email: "np@example.test" }
    ) as never;
  });
}

const post = (body: unknown, id = VISIT) =>
  POST(
    new Request("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id }) },
  );

const answer = (code: string, source = "structured_rule") => ({
  status: "ok", source, answer: `For CPT ${code}: covered.`, coverageStatus: "covered", confidence: 0.95,
  citation: { documentName: "Payer policy document", documentUrl: null, effectiveDate: "2026-01-01", verbatimQuote: "q", page: null },
  comparison: null, conflict: false,
  resolved: { payerId: MEDICARE, state: "OH", cptCode: code, attribute: "covered" },
});

beforeEach(() => {
  vi.clearAllMocks();
  owner = ME;
  onCareTeam = false;
  // 10 am EDT on 12 March 2026.
  coverage = { payer_id: MEDICARE, state: "OH", at: new Date("2026-03-12T14:00:00Z"), org_timezone: "America/New_York" };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
  vi.mocked(lookupRule).mockImplementation(async (req) => answer(req.cptCode!) as never);
  signInAs(ROLE_DEFAULT_PERMISSIONS.clinician);
});

describe("POST /api/visits/[id]/payer-rules — the clinician's panel", () => {
  it("CONTROL: the clinician role is refused by /api/billing/lookup, which the panel used", async () => {
    const res = await billingLookup(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payerId: MEDICARE, state: "OH", cptCode: "99350" }),
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(403);
    expect(lookupRule).not.toHaveBeenCalled();
  });

  it("answers the clinician on their own visit, every code in turn", async () => {
    const res = await post({ codes: ["99350", "G0318"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.data.results)).toEqual(["99350", "G0318"]);
    expect(body.data.results["99350"].coverageStatus).toBe("covered");
    expect(vi.mocked(lookupRule).mock.calls.map(([r]) => r.cptCode)).toEqual(["99350", "G0318"]);
  });

  it("reads the payer, the coverage state and the date of service from the visit", async () => {
    await post({ codes: ["99350"], attribute: "telehealth" });
    expect(lookupRule).toHaveBeenCalledWith({
      payerId: MEDICARE, state: "OH", cptCode: "99350", attribute: "telehealth", dos: "2026-03-12", orgId: ORG,
    });
  });

  it("ignores a payer, state or date sent in the request", async () => {
    await post({ codes: ["99350"], payerId: "a0000000-0000-4000-8000-000000000301", state: "NC", dos: "2026-11-03" });
    expect(lookupRule).toHaveBeenCalledWith(expect.objectContaining({ payerId: MEDICARE, state: "OH", dos: "2026-03-12" }));
  });

  it("dates the visit on the practice's clock, not UTC's", async () => {
    // 10:30 pm EDT on 12 March is already the 13th in UTC.
    coverage.at = new Date("2026-03-13T02:30:00Z");
    await post({ codes: ["99350"] });
    expect(lookupRule).toHaveBeenCalledWith(expect.objectContaining({ dos: "2026-03-12" }));
  });

  it("looks a repeated code up once", async () => {
    await post({ codes: ["99350", "99350"] });
    expect(lookupRule).toHaveBeenCalledTimes(1);
  });

  it("answers nothing, and asks nothing, when the patient has no payer on file", async () => {
    coverage.payer_id = null;
    const res = await post({ codes: ["99350"] });
    expect((await res.json()).data).toEqual({ dos: "2026-03-12", results: {} });
    expect(lookupRule).not.toHaveBeenCalled();
  });

  it("keeps an AI-written answer for review, as the billing lookup does", async () => {
    vi.mocked(lookupRule).mockResolvedValue(answer("99350", "ai_synthesized") as never);
    await post({ codes: ["99350"] });
    expect(persistSynthesizedRule).toHaveBeenCalledWith(expect.objectContaining({ source: "ai_synthesized" }), ORG);
  });

  it("reports a lookup that failed, with its reason", async () => {
    vi.mocked(lookupRule).mockRejectedValue(new Error("The rule library is unavailable."));
    const res = await post({ codes: ["99350"] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("The rule library is unavailable.");
  });
});

describe("POST /api/visits/[id]/payer-rules — whose visit", () => {
  it("refuses a clinician on another clinician's visit", async () => {
    owner = OTHER_CLINICIAN;
    const res = await post({ codes: ["99350"] });
    expect(res.status).toBe(403);
    expect(lookupRule).not.toHaveBeenCalled();
  });

  it("refuses before reading the body, so a refused caller learns nothing from its validation", async () => {
    owner = OTHER_CLINICIAN;
    const res = await post({ codes: "not a list" });
    expect(res.status).toBe(403);
  });

  it("answers a member of the patient's care team, who may read the visit", async () => {
    owner = OTHER_CLINICIAN;
    onCareTeam = true;
    expect((await post({ codes: ["99350"] })).status).toBe(200);
  });

  it("answers a caller who may read every visit", async () => {
    owner = OTHER_CLINICIAN;
    signInAs(ROLE_DEFAULT_PERMISSIONS.billing_agent);
    expect((await post({ codes: ["99350"] })).status).toBe(200);
  });

  it("refuses a role that reads no visits at all", async () => {
    signInAs(ROLE_DEFAULT_PERMISSIONS.intake_coordinator);
    expect((await post({ codes: ["99350"] })).status).toBe(403);
    expect(lookupRule).not.toHaveBeenCalled();
  });

  it("answers 404 for a visit that is not in the caller's org", async () => {
    owner = null;
    expect((await post({ codes: ["99350"] })).status).toBe(404);
  });
});

describe("POST /api/visits/[id]/payer-rules — the request", () => {
  it.each([
    ["no codes", { codes: [] }],
    ["more than ten codes", { codes: Array.from({ length: 11 }, (_, i) => String(99341 + i)) }],
    ["a malformed code", { codes: ["9935"] }],
    ["an unknown attribute", { codes: ["99350"], attribute: "everything" }],
  ])("refuses %s with 422", async (_name, body) => {
    expect((await post(body)).status).toBe(422);
    expect(lookupRule).not.toHaveBeenCalled();
  });

  it("answers a malformed visit id as not found, like every visit route", async () => {
    expect((await post({ codes: ["99350"] }, "not-a-uuid")).status).toBe(404);
  });
});
