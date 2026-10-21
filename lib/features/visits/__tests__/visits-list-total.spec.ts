/**
 * GET /api/visits — the `total` beside the rows.
 *
 * It used to be visits.length, so a patient with 206 visits read "50 visits on
 * file" on their chart and the 156 oldest — the start of the illness —
 * vanished without a word. That is audit R34, declared fixed in
 * components/ui/pager.tsx: it was fixed for the two billing queues and missed
 * here.
 *
 * The number crosses clinicians, which is why it is worth a spec of its own. A
 * caller holding visits.view.own is shown their own rows; if the count were
 * taken without that same narrowing they would be told how many visits the
 * whole org has while looking at their own handful — a leak of one clinic's
 * caseload size to every nurse in it, and an impossible "Latest 12 of 206".
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/calendar/google-calendar.service", () => ({
  getBusyForClinician: vi.fn().mockResolvedValue([]),
  pushVisitToGoogle: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/features/visits/visit.service", () => ({
  listVisits: vi.fn(),
  scheduleVisit: vi.fn(),
  getDailyCapacityStatus: vi.fn(),
}));

import { GET } from "@/app/api/visits/route";
import type { Session } from "@/lib/auth";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { listVisits } from "@/lib/features/visits/visit.service";
import type { VisitView } from "@/lib/features/visits/visit.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PATIENT = "f0000000-0000-4000-8000-000000000001";

const session = (permissions: string[]): Session => ({
  userId: ME,
  orgId: ORG,
  role: "clinician",
  permissions,
  email: "nurse@design-partner.test",
});

const req = (qs: string) =>
  new Request(`http://localhost/api/visits${qs}`) as unknown as NextRequest;

/**
 * The route never reads a visit's fields — it counts them and forwards them —
 * so a page of stubs with ids is the whole of what it sees.
 */
const page = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `v${i}` })) as unknown as VisitView[];

/** Every COUNT the handler issued, with the values it bound. */
let counts: { sql: string; values: unknown[] }[];
let countN: bigint;
/** Rows the count query answers with at all — [] models an empty result. */
let countRows: { n: bigint }[] | null;

beforeEach(() => {
  vi.clearAllMocks();
  counts = [];
  // BigInt(), not a 206n literal — the repo targets below ES2020.
  countN = BigInt(206);
  countRows = null;
  vi.mocked(withOrgContext).mockImplementation(
    async <T,>(_orgId: string, fn: (tx: never) => Promise<T>): Promise<T> =>
      fn({
        $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
          counts.push({ sql: strings.join("¶"), values });
          return Promise.resolve(countRows ?? [{ n: countN }]);
        },
      } as never),
  );
  vi.mocked(listVisits).mockResolvedValue(page(50));
  vi.mocked(requireAuth).mockResolvedValue(session(["visits.view.all"]));
});

const body = async (r: Response) =>
  (await r.json()) as { success: boolean; data: { rows: unknown[]; total: number } };

describe("GET /api/visits — total", () => {
  it("reports the whole filtered set, not the page it returned", async () => {
    const d = await body(await GET(req(`?patientId=${PATIENT}&limit=50`)));
    expect(d.data.rows).toHaveLength(50);
    expect(d.data.total).toBe(206);
  });

  it("counts under the same predicates the list was filtered by", async () => {
    // A total counted over a different row set is a fresh untruth in place of
    // the old one.
    await GET(req(`?patientId=${PATIENT}&status=scheduled&limit=50`));
    expect(counts).toHaveLength(1);
    expect(counts[0]!.sql).toContain("COUNT(*)::bigint AS n FROM visit v");
    expect(counts[0]!.sql).not.toContain("LIMIT");
    expect(counts[0]!.values).toContain(PATIENT);
    expect(counts[0]!.values).toContain("scheduled");
    // listVisits names the org as well as relying on RLS, so the count does too
    // (org-predicates.spec.ts runs both against two orgs).
    expect(counts[0]!.values).toContain(ORG);
  });

  it("narrows the count to a .own-only clinician's own visits", async () => {
    // The leak this spec exists for: the rows are forced to session.userId, so
    // the count has to be given the same value. Asking for someone else's id
    // must not widen either half.
    vi.mocked(requireAuth).mockResolvedValue(session(["visits.view.own"]));
    vi.mocked(listVisits).mockResolvedValue(page(12));
    const d = await body(await GET(req(`?clinicianUserId=${OTHER}&limit=50`)));
    expect(vi.mocked(listVisits).mock.calls[0]![0].clinicianUserId).toBe(ME);
    expect(counts[0]!.values).toContain(ME);
    expect(counts[0]!.values).not.toContain(OTHER);
    expect(d.data.total).toBe(206);
  });

  it("still lets visits.view.all ask for another clinician", async () => {
    // CONTROL for the narrowing above: a scheduler holding .all is not pinned
    // to their own caseload.
    await GET(req(`?clinicianUserId=${OTHER}&limit=50`));
    expect(vi.mocked(listVisits).mock.calls[0]![0].clinicianUserId).toBe(OTHER);
    expect(counts[0]!.values).toContain(OTHER);
  });

  it("does not count for a caller it refuses", async () => {
    vi.mocked(requireAuth).mockResolvedValue(session(["patients.view"]));
    expect((await GET(req("?limit=50"))).status).toBe(403);
    expect(counts).toHaveLength(0);
    expect(listVisits).not.toHaveBeenCalled();
  });

  it("reads 0 rather than NaN when the count comes back empty", async () => {
    countRows = [];
    vi.mocked(listVisits).mockResolvedValue(page(0));
    const d = await body(await GET(req("?limit=50")));
    expect(d.data.total).toBe(0);
  });
});
