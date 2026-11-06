/**
 * Search vectors for the sections stored without one (6 on production on
 * 6 Nov 2026, from a policy uploaded while OpenAI had no credit). Nothing ever
 * came back for them before this.
 *
 * The database and OpenAI are fakes here; the SQL itself runs against
 * Postgres with pgvector in the WSL rehearsal, through the real route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  queries: [] as { sql: string; values: unknown[] }[],
  writes: [] as { sql: string; values: unknown[] }[],
  pending: [] as { id: string; content: string }[],
  /** ids that already have a vector when the UPDATE runs (another run got there first). */
  filled: new Set<string>(),
  breakglassReasons: [] as string[],
}));

vi.mock("@/lib/db", () => {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (/^\s*UPDATE document_chunk/.test(sql)) {
      db.writes.push({ sql, values });
      const id = values[1] as string;
      if (db.filled.has(id)) return Promise.resolve(0);
      db.filled.add(id);
      return Promise.resolve(1);
    }
    db.queries.push({ sql, values });
    if (/COUNT\(\*\)/.test(sql)) return Promise.resolve([{ n: BigInt(db.pending.filter((c) => !db.filled.has(c.id)).length) }]);
    return Promise.resolve(db.pending.filter((c) => !db.filled.has(c.id)).slice(0, values[0] as number));
  };
  const client = { $queryRaw: run, $executeRaw: run };
  return {
    prisma: client,
    withBreakglass: vi.fn(async (fn: (c: unknown) => Promise<unknown>, reason: string) => {
      db.breakglassReasons.push(reason);
      return fn(client);
    }),
  };
});

const ai = vi.hoisted(() => ({ configured: true, failAt: -1, failWith: null as unknown, calls: [] as string[] }));
vi.mock("@/lib/ai/embedder", () => ({
  isEmbedderConfigured: () => ai.configured,
  embed: vi.fn(async (text: string) => {
    ai.calls.push(text);
    if (ai.calls.length - 1 === ai.failAt) throw ai.failWith;
    return Array.from({ length: 1024 }, (_, i) => (i === 0 ? 0.5 : 0));
  }),
}));

import { BACKFILL_LIMIT, describeEmbedFailure, embedMissingChunks } from "../embed-backfill.service";

/** The OpenAI SDK's error for an exhausted quota, as OpenAI documents it. */
const NO_CREDIT = Object.assign(new Error("429 You exceeded your current quota, please check your plan and billing details."), {
  status: 429,
  code: "insufficient_quota",
});

/**
 * What production's account answered on 7 Nov 2026 (its pm2 log): a 429 that
 * says so in words, without the insufficient_quota code. Read by its code
 * alone it was "limiting requests just now", which sends nobody to add credit.
 */
const PRODUCTION_NO_CREDIT = Object.assign(
  new Error("429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/."),
  { status: 429, code: null, type: null },
);

/** A real rate limit, in OpenAI's words: nothing to do with credit. */
const RATE_LIMITED = Object.assign(
  new Error("429 Rate limit reached for text-embedding-3-large in organization org-test on requests per min (RPM): Limit 3000, Used 3000, Requested 1. Please try again in 20ms."),
  { status: 429, code: "rate_limit_exceeded", type: "requests" },
);

beforeEach(() => {
  db.queries = [];
  db.writes = [];
  db.filled = new Set();
  db.breakglassReasons = [];
  db.pending = [
    { id: "c0000000-0000-4000-8000-000000000001", content: "Section one of a payer letter." },
    { id: "c0000000-0000-4000-8000-000000000002", content: "Section two." },
    { id: "c0000000-0000-4000-8000-000000000003", content: "Section three." },
  ];
  ai.configured = true;
  ai.failAt = -1;
  ai.failWith = null;
  ai.calls = [];
});

describe("embedMissingChunks", () => {
  it("gives every section without a vector one, oldest first, and says none are left", async () => {
    const r = await embedMissingChunks();
    expect(r).toEqual({ embedded: 3, remaining: 0, stoppedBecause: null });
    expect(ai.calls).toEqual(["Section one of a payer letter.", "Section two.", "Section three."]);
    const list = db.queries.find((q) => /SELECT id, content FROM document_chunk/.test(q.sql))!;
    expect(list.sql).toMatch(/WHERE embedding IS NULL/);
    expect(list.sql).toMatch(/ORDER BY created_at, source_doc_id, chunk_index/);
    expect(list.values[0]).toBe(BACKFILL_LIMIT);
    // Written only where there is still none, as a pgvector literal of 1024 numbers.
    for (const w of db.writes) {
      expect(w.sql).toMatch(/SET embedding = \?::vector/);
      expect(w.sql).toMatch(/AND embedding IS NULL/);
      expect((w.values[0] as string).split(",")).toHaveLength(1024);
    }
    // Through the admin connection, as ingestion writes the table, in one call.
    expect(db.breakglassReasons).toHaveLength(1);
  });

  it("stops at the first refusal, keeps what it did, and says why in words that never quote the document", async () => {
    ai.failAt = 1;
    ai.failWith = NO_CREDIT;
    const r = await embedMissingChunks();
    expect(r.embedded).toBe(1);
    expect(r.remaining).toBe(2);
    expect(r.stoppedBecause).toBe("OpenAI has no credit left on this account. Add credit, then run this again.");
    // The third section was not tried: a refusal that outlasted the retries will not clear by the next one.
    expect(ai.calls).toHaveLength(2);
    expect(r.stoppedBecause).not.toContain("Section");
  });

  it("CONTROL: with OpenAI refusing the first section, writes nothing at all", async () => {
    ai.failAt = 0;
    ai.failWith = NO_CREDIT;
    const r = await embedMissingChunks();
    expect(r).toEqual({ embedded: 0, remaining: 3, stoppedBecause: expect.stringMatching(/no credit/) });
    expect(db.writes).toHaveLength(0);
    expect(db.breakglassReasons).toHaveLength(0);
  });

  it("says the account has no credit when OpenAI says so only in words, as production's did", async () => {
    ai.failAt = 0;
    ai.failWith = PRODUCTION_NO_CREDIT;
    const r = await embedMissingChunks();
    expect(r).toEqual({
      embedded: 0,
      remaining: 3,
      stoppedBecause: "OpenAI has no credit left on this account. Add credit, then run this again.",
    });
  });

  it("does nothing without a key, and says so", async () => {
    ai.configured = false;
    const r = await embedMissingChunks();
    expect(r).toEqual({ embedded: 0, remaining: 3, stoppedBecause: expect.stringMatching(/No OpenAI key is set/) });
    expect(ai.calls).toHaveLength(0);
  });

  it("counts only the vectors it wrote when another run got to a section first", async () => {
    // The second section is filled between this run's read and its write.
    const original = db.pending.slice();
    db.filled = new Set();
    const r1 = embedMissingChunks();
    db.filled.add(original[1]!.id);
    const r = await r1;
    expect(r.embedded).toBe(2);
    expect(r.remaining).toBe(0);
  });

  it("asks for at most its limit a run", async () => {
    await embedMissingChunks({ limit: 2 });
    const list = db.queries.find((q) => /SELECT id, content FROM document_chunk/.test(q.sql))!;
    expect(list.values[0]).toBe(2);
    await embedMissingChunks({ limit: 10_000 });
    expect(db.queries.filter((q) => /SELECT id, content/.test(q.sql)).at(-1)!.values[0]).toBe(BACKFILL_LIMIT);
  });
});

describe("describeEmbedFailure", () => {
  it("names what the person who can fix it needs to do", () => {
    expect(describeEmbedFailure(NO_CREDIT)).toMatch(/no credit/);
    expect(describeEmbedFailure(Object.assign(new Error("401"), { status: 401 }))).toMatch(/refused the API key/);
    expect(describeEmbedFailure(Object.assign(new Error("429"), { status: 429, code: "rate_limit_exceeded" }))).toMatch(/limiting requests/);
    expect(describeEmbedFailure(Object.assign(new Error("500"), { status: 500 }))).toMatch(/HTTP 500/);
    expect(describeEmbedFailure(new Error("fetch failed"))).toMatch(/could not be reached/);
  });

  it("knows no credit by OpenAI's code, its type, or its words", () => {
    expect(describeEmbedFailure(PRODUCTION_NO_CREDIT)).toMatch(/no credit/);
    expect(describeEmbedFailure(Object.assign(new Error("429 quota"), { status: 429, code: null, type: "insufficient_quota" }))).toMatch(/no credit/);
    // The words alone, from an error that lost its status on the way up.
    expect(describeEmbedFailure(new Error("429 You have no credits remaining. Add credits to continue."))).toMatch(/no credit/);
  });

  it("CONTROL: a real rate limit is still a rate limit", () => {
    expect(describeEmbedFailure(RATE_LIMITED)).toMatch(/limiting requests/);
  });
});
