/**
 * Which seats on a patient's care team put them on someone's caseload, the
 * chaplain's among them (0127).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { listCaseload } from "../caseload.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";

let sqlSeen: string[];

const row = (seat: Partial<Record<"np" | "rn" | "sw" | "ch" | "ba", boolean>>) => ({
  id: "p", name: "Test Patient", acuity: null, admitted_on: null, np: false, rn: false, sw: false, ch: false, ba: false,
  last_visit_on: null, next_visit_on: null, last_call_on: null, open_tasks: 0, open_alerts: 0, monitoring: [], review_on: null, programs: [], ...seat,
});

let rows: ReturnType<typeof row>[];

beforeEach(() => {
  sqlSeen = [];
  rows = [];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)({
      $queryRaw: (strings: TemplateStringsArray) => {
        const sql = strings.join("¶");
        sqlSeen.push(sql);
        if (sql.includes("SELECT timezone FROM org")) return Promise.resolve([{ timezone: "America/New_York" }]);
        return Promise.resolve(rows);
      },
    }),
  );
});

describe("the caseload", () => {
  it("names the chaplain's seat", async () => {
    rows = [row({ ch: true })];
    const r = await listCaseload({ orgId: ORG, userId: ME });
    expect(r.rows[0]!.seats).toEqual(["chaplain"]);
  });

  it("asks for the chaplain among the seats that put a patient on it", async () => {
    await listCaseload({ orgId: ORG, userId: ME });
    expect(sqlSeen.join(" ")).toMatch(/IN \(p\.primary_np_user_id, p\.rn_user_id, p\.social_worker_user_id, p\.chaplain_user_id, p\.billing_agent_user_id\)/);
  });

  it("CONTROL: another seat is not the chaplain's", async () => {
    rows = [row({ sw: true })];
    const r = await listCaseload({ orgId: ORG, userId: ME });
    expect(r.rows[0]!.seats).toEqual(["social_worker"]);
  });
});
