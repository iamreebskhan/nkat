/**
 * Resolving an attestation request must cite a document this org can open.
 *
 * POST /api/attestations/requests/[id]/resolve takes attestationId from the
 * body, validated only as a uuid, behind a permission three role templates
 * carry. The write used to file that id verbatim: analyst_attestation's FK is
 * checked with row security disabled, so another tenant's attestation id was
 * accepted, and the queue then showed "resolved — see attestation X" for an X
 * that GET /api/attestations/[id] 404s for everyone in this org. A
 * non-existent id was an FK violation, i.e. a 500. And with no status guard —
 * unlike its sibling claimRequest — a request already resolved could be
 * silently re-pointed at a different attestation.
 *
 * Nothing exercised resolveRequest at all before this file: attestation
 * .service.ts was imported by six route files and zero specs.
 *
 * lib/db is mocked with a fake tx that holds the two tables as ROWS and reads
 * the statement's own predicates to decide which of them it touches — so a
 * guard that stops asking changes the answer instead of being invisible.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { resolveRequest } from "../attestation.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

const OPEN = "a0000000-0000-4000-8000-000000000001";
const CLAIMED = "a0000000-0000-4000-8000-000000000002";
const DONE = "a0000000-0000-4000-8000-000000000003";
/** A request row belonging to the other tenant. */
const FOREIGN_REQUEST = "a0000000-0000-4000-8000-000000000004";

const OURS = "b0000000-0000-4000-8000-000000000001";
const ALSO_OURS = "b0000000-0000-4000-8000-000000000002";
/** An attestation row belonging to the other tenant. */
const THEIRS = "b0000000-0000-4000-8000-000000000003";
/** A well-formed uuid with no attestation row behind it at all. */
const GONE = "b0000000-0000-4000-8000-0000000000ff";

interface RequestRow {
  id: string;
  org_id: string;
  status: string;
  resolved_attestation_id: string | null;
  resolution_note: string | null;
}

let requests: RequestRow[];
let attestations: { id: string; org_id: string }[];
/**
 * Whether the connection enforces RLS. The app role does; .env.local runs
 * local dev as the `admin` superuser, which does not — so the org predicate
 * in the statement is the only thing standing between the two tenants there.
 */
let rlsInForce: boolean;
let currentOrg: string;
let statements: { sql: string; values: unknown[] }[];

/** The value bound at the first ¶ after `upTo`, or undefined if not present. */
function bound(sql: string, values: unknown[], upTo: RegExp): unknown {
  const m = sql.match(upTo);
  if (m?.index === undefined) return undefined;
  const before = sql.slice(0, m.index + m[0].length);
  return values[(before.match(/¶/g) ?? []).length];
}

/** The literals inside `... IN ('a', 'b')`, or null when there is no such list. */
function statusList(sql: string): string[] | null {
  const inner = sql.match(/status\s+IN\s*\(([^)]*)\)/)?.[1];
  return inner ? inner.split(",").map((s) => s.trim().replace(/^'|'$/g, "")) : null;
}

/**
 * A very small stand-in for Postgres over the two tables above: it holds rows
 * and works out which of them the UPDATE touches by reading the statement's
 * own predicates, never by restating the rule. Stop joining
 * analyst_attestation, drop `a.org_id = r.org_id`, or drop the status list,
 * and what comes back changes — which is what lets the tests below fail.
 */
function runUpdate(sql: string, values: unknown[]): number {
  // Rows of another tenant are simply not there under RLS.
  const visible = <T extends { org_id: string }>(rows: T[]) =>
    rlsInForce ? rows.filter((r) => r.org_id === currentOrg) : rows;

  const req = visible(requests).find((r) => r.id === bound(sql, values, /WHERE\s+(?:r\.)?id\s*=\s*/));
  if (!req) return 0;
  // The request's own org, where the statement names one.
  const org = bound(sql, values, /\br\.org_id\s*=\s*(?=¶)/);
  if (org !== undefined && req.org_id !== org) return 0;
  const admitted = statusList(sql);
  if (admitted && !admitted.includes(req.status)) return 0;

  let citation: string | null;
  if (/FROM\s+analyst_attestation\b/.test(sql)) {
    const wantsOrgMatch = /a\.org_id\s*=\s*r\.org_id/.test(sql);
    const att = visible(attestations).find(
      (a) =>
        a.id === bound(sql, values, /\ba\.id\s*=\s*/) && (!wantsOrgMatch || a.org_id === req.org_id),
    );
    if (!att) return 0;
    citation = att.id;
  } else {
    // No join: whatever the caller posted is filed as it stands, which is what
    // the FK — checked with row security disabled — would have accepted.
    citation = (bound(sql, values, /resolved_attestation_id\s*=\s*/) as string) ?? null;
  }

  req.status = "resolved";
  req.resolved_attestation_id = citation;
  const note = bound(sql, values, /resolution_note\s*=\s*COALESCE\(/) as string | null;
  req.resolution_note = note ?? req.resolution_note;
  return 1;
}

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    statements.push({ sql, values });
    return Promise.resolve(runUpdate(sql, values));
  };
  return { $queryRaw: () => Promise.resolve([]), $executeRaw: run };
}

beforeEach(() => {
  statements = [];
  rlsInForce = true;
  requests = [
    { id: OPEN, org_id: ORG, status: "open", resolved_attestation_id: null, resolution_note: null },
    { id: CLAIMED, org_id: ORG, status: "in_progress", resolved_attestation_id: null, resolution_note: null },
    { id: DONE, org_id: ORG, status: "resolved", resolved_attestation_id: OURS, resolution_note: "Called Aetna 9/14." },
    { id: FOREIGN_REQUEST, org_id: OTHER_ORG, status: "open", resolved_attestation_id: null, resolution_note: null },
  ];
  attestations = [
    { id: OURS, org_id: ORG },
    { id: ALSO_OURS, org_id: ORG },
    { id: THEIRS, org_id: OTHER_ORG },
  ];
  vi.mocked(withOrgContext).mockImplementation(async (orgId, fn) => {
    currentOrg = orgId;
    return (fn as (tx: unknown) => Promise<unknown>)(fakeTx());
  });
});

const resolve = (over: Partial<Parameters<typeof resolveRequest>[0]> = {}) =>
  resolveRequest({ orgId: ORG, id: OPEN, attestationId: OURS, note: "Confirmed by phone.", ...over });
const rowFor = (id: string) => requests.find((r) => r.id === id)!;
const NOT_FOUND = { name: "NotFoundError", message: "That request is not open, or that attestation was not found." };

describe("resolveRequest", () => {
  it("closes an open request and cites the attestation", async () => {
    await expect(resolve()).resolves.toBeUndefined();
    expect(rowFor(OPEN)).toMatchObject({
      status: "resolved",
      resolved_attestation_id: OURS,
      resolution_note: "Confirmed by phone.",
    });
  });

  it("closes a request an analyst had already claimed", async () => {
    await expect(resolve({ id: CLAIMED })).resolves.toBeUndefined();
    expect(rowFor(CLAIMED)).toMatchObject({ status: "resolved", resolved_attestation_id: OURS });
  });

  it("keeps the note that is already on the row when the caller sends none", async () => {
    await expect(resolve({ id: CLAIMED, note: undefined })).resolves.toBeUndefined();
    expect(rowFor(CLAIMED).resolution_note).toBeNull();
    expect(statements[0]!.sql).toContain("COALESCE");
  });

  it("404s a citation belonging to another tenant, and leaves the request open", async () => {
    await expect(resolve({ attestationId: THEIRS })).rejects.toMatchObject(NOT_FOUND);
    expect(rowFor(OPEN)).toMatchObject({ status: "open", resolved_attestation_id: null });
  });

  it("404s an attestation id with no row behind it, instead of raising a foreign-key 500", async () => {
    await expect(resolve({ attestationId: GONE })).rejects.toMatchObject(NOT_FOUND);
    expect(rowFor(OPEN)).toMatchObject({ status: "open", resolved_attestation_id: null });
  });

  it("refuses to re-point a request that is already resolved", async () => {
    await expect(resolve({ id: DONE, attestationId: ALSO_OURS })).rejects.toMatchObject(NOT_FOUND);
    expect(rowFor(DONE)).toMatchObject({
      status: "resolved",
      resolved_attestation_id: OURS,
      resolution_note: "Called Aetna 9/14.",
    });
  });

  it("refuses the foreign citation even on a connection where RLS is not enforced", async () => {
    // Local dev runs as the admin superuser: RLS is off there, so the org
    // match written into the statement is the whole of the boundary.
    rlsInForce = false;
    await expect(resolve({ attestationId: THEIRS })).rejects.toMatchObject(NOT_FOUND);
    expect(rowFor(OPEN)).toMatchObject({ status: "open", resolved_attestation_id: null });
  });

  it("does not resolve another tenant's request, even where RLS is not enforced", async () => {
    // Their request cited with their own attestation passes `a.org_id =
    // r.org_id`; only the org named in the statement keeps it out of reach.
    rlsInForce = false;
    await expect(resolve({ id: FOREIGN_REQUEST, attestationId: THEIRS })).rejects.toMatchObject(NOT_FOUND);
    expect(rowFor(FOREIGN_REQUEST)).toMatchObject({ status: "open", resolved_attestation_id: null });
  });

  it("CONTROL: a request row belonging to another tenant is not found here", async () => {
    await expect(resolve({ id: FOREIGN_REQUEST })).rejects.toMatchObject(NOT_FOUND);
    expect(rowFor(FOREIGN_REQUEST)).toMatchObject({ status: "open", resolved_attestation_id: null });
  });

  it("CONTROL: the same request resolves in the org that owns it", async () => {
    await expect(
      resolveRequest({ orgId: OTHER_ORG, id: FOREIGN_REQUEST, attestationId: THEIRS }),
    ).resolves.toBeUndefined();
    expect(rowFor(FOREIGN_REQUEST)).toMatchObject({ status: "resolved", resolved_attestation_id: THEIRS });
  });
});
