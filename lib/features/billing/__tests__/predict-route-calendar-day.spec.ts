/**
 * POST /api/superbills/predict — the date of service must be a day that exists.
 *
 * The schema checked only the YYYY-MM-DD shape. Since the payer documentation
 * check runs on the date being scored (0107), an unbilled visit's check binds
 * that day into ::date, and Postgres refuses a day that does not exist
 * ("date/time field value out of range": 2026-02-30, 2026-09-31), so a
 * hand-made request got a 500. It is refused at the schema now, with the 422
 * the repo answers a refused request with, before anything is read.
 *
 * The route and the service run for real; only auth and the database are
 * faked. The fake casts every bind the statement casts to ::date as Postgres
 * would, and answers the visit read with only the columns it selects.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/billing/denial-feedback.service", () => ({
  getDenialRuleMetrics: vi.fn(async () => ({})),
}));

import { POST } from "@/app/api/superbills/predict/route";
import type { Session } from "@/lib/auth";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAYER = "a0000000-0000-4000-8000-000000000302";
const VISIT = "e0000000-0000-4000-8000-00000000000c";
/** 11 am EDT on 9 Sep. */
const VISIT_AT = new Date("2026-09-09T15:00:00Z");

const SESSION: Session = {
  userId: USER,
  orgId: ORG,
  role: "billing_agent",
  permissions: ["superbill.predict"],
  email: "biller@design-partner.test",
};

let calls: { sql: string; values: unknown[] }[] = [];

/** What `bind::date` is to Postgres: a day that exists, or SQLSTATE 22008. */
function castToDate(bind: unknown): string {
  if (typeof bind !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(bind)) {
    throw new Error(`the fake models only YYYY-MM-DD binds into ::date, not ${String(bind)}`);
  }
  const t = Date.parse(`${bind}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== bind) {
    throw new Error(`date/time field value out of range: "${bind}"`);
  }
  return bind;
}

/**
 * The visit read for a visit with no bill yet, as a UTC session answers it:
 * no bill, so no bill date; a ::date cast is the instant's UTC day; the
 * instant and the org's zone only when selected.
 */
function unbilledVisit(sql: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    is_telehealth: false, telehealth_modality: null, total_minutes: 45, dx_count: 1,
    state: "OH", payer_id: PAYER, payer_name: "UnitedHealthcare Community Plan Ohio", codes: ["99349"],
    filled_keys: ["hpi"], template_keys: ["hpi"], has_vitals: true, document_text: null,
  };
  if (/\blb\.date_of_service AS dos\b/.test(sql)) row.dos = null;
  else if (/COALESCE\(dv\.start_time, dv\.scheduled_start\)::date AS dos\b/.test(sql)) {
    row.dos = new Date(`${VISIT_AT.toISOString().slice(0, 10)}T00:00:00Z`);
  } else throw new Error("the visit read selected no dos this fake can evaluate");
  if (/COALESCE\(dv\.start_time, dv\.scheduled_start\) AS visit_at\b/.test(sql)) row.visit_at = VISIT_AT;
  if (/\bo\.timezone AS org_timezone\b/.test(sql) && /\bJOIN org o ON o\.id = dv\.org_id\b/.test(sql)) {
    row.org_timezone = "America/New_York";
  }
  return row;
}

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    // Every bind the statement casts to a date is cast before a row comes back.
    values.forEach((v, i) => {
      if (strings[i + 1]!.startsWith("::date")) castToDate(v);
    });
    if (sql.includes("FROM payer_allowed_codes_v")) return Promise.resolve([]);
    if (sql.includes("FROM visit dv")) return Promise.resolve([unbilledVisit(sql)]);
    if (sql.includes("FROM documentation_requirement")) return Promise.resolve([]);
    if (sql.includes("FROM superbill")) return Promise.resolve([]);
    throw new Error(`the fake models no such statement: ${sql}`);
  };
  return { $queryRaw: run, $executeRaw: run };
}

const body = {
  payerId: PAYER, state: "OH", patientId: "f0000000-0000-4000-8000-000000000001",
  dos: "2026-09-09", cptCodes: ["99349"], visitId: VISIT,
};

const post = (b: unknown) =>
  POST(
    new Request("http://localhost/api/superbills/predict", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    }) as unknown as NextRequest,
  );

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  vi.mocked(requireAuth).mockResolvedValue(SESSION);
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("POST /api/superbills/predict — the date of service is a day that exists", () => {
  it.each(["2026-02-30", "2026-09-31", "2026-13-01"])(
    "CONTROL: refuses %s with 422 before reading anything, not a 500",
    async (dos) => {
      const res = await post({ ...body, dos });
      expect(res.status).toBe(422);
      expect((await res.json()).success).toBe(false);
      expect(withOrgContext).not.toHaveBeenCalled();
    },
  );

  it("twin: a day that exists is scored, its documentation checked on that day", async () => {
    const res = await post(body);
    expect(res.status).toBe(200);
    const q = calls.find((c) => c.sql.includes("FROM documentation_requirement"))!;
    expect(q.values).toContain("2026-09-09");
  });
});
