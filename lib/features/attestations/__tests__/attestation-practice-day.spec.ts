/**
 * Attestation expiry is counted in the practice's days (0107).
 *
 * The sweep compared expires_at with now()::date, the database session's day;
 * the inbox's reminder window used CURRENT_DATE, and its 15/5/0-day marks the
 * server's clock in UTC. From 8 pm in Ohio all three were a day ahead: an
 * attestation on its last day was swept as expired and read "overdue", and
 * the "expires in 15 days" reminder came a day early.
 *
 * Every case runs at 9:30 pm EDT on 20 Oct, which is 01:30 UTC on the 21st.
 * The fake answers each statement by applying the day it binds, so a
 * statement that binds no day (now()::date, CURRENT_DATE) cannot be answered
 * and fails here rather than passing on the session's clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/rulebook/org-rule.repository", () => ({ upsertOrgRule: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { listInbox } from "@/lib/features/inbox/inbox.service";

import { attestationToday, sweepExpired } from "../attestation.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** 9:30 pm EDT on Tue 20 Oct. */
const OHIO_EVENING = new Date("2026-10-21T01:30:00Z");

interface Att {
  id: string;
  org_id: string;
  status: string;
  cpt_code: string;
  state: string;
  expires_at: string;
}
let attestations: Att[];
let zone: string;
let calls: { sql: string; values: unknown[] }[];

/** The value bound at the `¶` that `re` locates, as in predict-superbill.spec.ts. */
function boundIn(sql: string, values: unknown[], re: RegExp): unknown {
  const m = re.exec(sql);
  if (!m) return undefined;
  const at = m.index + m[0].indexOf("¶");
  return values[sql.slice(0, at).split("¶").length - 1];
}

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT timezone FROM org")) return Promise.resolve([{ timezone: zone }]);
    if (sql.includes("UPDATE analyst_attestation")) {
      const before = boundIn(sql, values, /expires_at < ¶/);
      const org = boundIn(sql, values, /\borg_id = ¶/);
      if (typeof before !== "string") throw new Error("the sweep binds no day this fake can apply");
      const swept = attestations.filter(
        (a) => a.status === "active" && a.expires_at < before && (org === undefined || a.org_id === org),
      );
      for (const a of swept) a.status = "expired";
      return Promise.resolve(swept.map((a) => ({ id: a.id })));
    }
    if (sql.includes("FROM analyst_attestation a")) {
      const from = boundIn(sql, values, /expires_at >= ¶/);
      const to = boundIn(sql, values, /expires_at <= ¶/);
      const org = boundIn(sql, values, /\ba\.org_id = ¶/);
      if (typeof from !== "string" || typeof to !== "string") {
        throw new Error("the reminder window binds no days this fake can apply");
      }
      return Promise.resolve(
        attestations
          .filter((a) => a.status === "active" && a.expires_at >= from && a.expires_at <= to)
          .filter((a) => org === undefined || a.org_id === org)
          .map((a) => ({ ...a, expires_at: new Date(`${a.expires_at}T00:00:00Z`), payer_name: "Humana" })),
      );
    }
    // The inbox's visit and request reads: nothing waiting.
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OHIO_EVENING);
  zone = "America/New_York";
  calls = [];
  attestations = [];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

const att = (id: string, expires_at: string, over: Partial<Att> = {}): Att => ({
  id, org_id: ORG, status: "active", cpt_code: "99350", state: "OH", expires_at, ...over,
});

describe("sweepExpired — expired by the practice's today", () => {
  it("keeps an attestation active through its last day in Ohio", async () => {
    attestations = [att("last-day", "2026-10-20")];
    expect(await sweepExpired({ orgId: ORG })).toEqual({ swept: 0 });
    expect(attestations[0]!.status).toBe("active");
  });

  it("CONTROL: expires one whose last day has passed in Ohio", async () => {
    attestations = [att("past", "2026-10-19")];
    expect(await sweepExpired({ orgId: ORG })).toEqual({ swept: 1 });
    expect(attestations[0]!.status).toBe("expired");
  });

  it("writes this org's rows only", async () => {
    attestations = [att("theirs", "2026-10-01", { org_id: OTHER_ORG })];
    expect(await sweepExpired({ orgId: ORG })).toEqual({ swept: 0 });
    expect(attestations[0]!.status).toBe("active");
  });

  it("follows the org's own zone", async () => {
    // 01:30 UTC on the 21st is 3:30 pm on the 20th in Honolulu, too.
    zone = "Pacific/Honolulu";
    expect(await attestationToday({ orgId: ORG })).toBe("2026-10-20");
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    expect(await attestationToday({ orgId: ORG })).toBe("2026-10-21");
  });
});

describe("listInbox — re-verification reminders on the practice's day", () => {
  const titles = async () =>
    (await listInbox({ orgId: ORG, userId: USER, canSeeDenials: false, canAttest: true }))
      .filter((i) => i.kind === "attestation_expiring")
      .map((i) => i.title);

  it("says an attestation on its last day in Ohio expires TODAY", async () => {
    attestations = [att("last-day", "2026-10-20")];
    expect(await titles()).toEqual(["Attestation expires TODAY — 99350"]);
  });

  it("gives the 15-day reminder on the 15th day before, not a day early", async () => {
    attestations = [att("fifteen", "2026-11-04"), att("fourteen", "2026-11-03")];
    expect(await titles()).toEqual(["Attestation expires in 15 days — 99350"]);
  });

  it("CONTROL: nothing for an attestation that is on no mark today", async () => {
    attestations = [att("ten", "2026-10-30")];
    expect(await titles()).toEqual([]);
  });

  it("reads this org's attestations only", async () => {
    attestations = [att("theirs", "2026-10-20", { org_id: OTHER_ORG })];
    expect(await titles()).toEqual([]);
  });

  it("does not read the zone, or attestations, for someone who cannot attest", async () => {
    attestations = [att("last-day", "2026-10-20")];
    const items = await listInbox({ orgId: ORG, userId: USER, canSeeDenials: false, canAttest: false });
    expect(items).toEqual([]);
    expect(calls.some((c) => c.sql.includes("SELECT timezone FROM org"))).toBe(false);
  });
});
