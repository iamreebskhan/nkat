/**
 * Search vectors for the document sections stored without one.
 *
 * A document is stored whether or not OpenAI answers (documentChunkEmbedder):
 * a section it could not embed keeps a NULL vector and is found by its words
 * only. Nothing ever came back for those sections, so a policy uploaded while
 * the account had no credit stayed word-search only after credit was added. On
 * production, 6 of 4,588 sections on 6 Nov 2026.
 *
 * This embeds them, oldest first, at most `limit` a run, and stops at the
 * first failure: one that outlasts the client's retries (no credit, a refused
 * key) will not clear by the next section. A vector is written only where the
 * section still has none, so two runs at once write each section once. Run
 * nightly by POST /api/cron/embed-chunks, and from the Documents page by a
 * platform admin.
 */
import { embed, isEmbedderConfigured } from "@/lib/ai/embedder";
import { prisma, withBreakglass } from "@/lib/db";

export interface EmbedBackfillResult {
  /** Sections given a vector by this run. */
  embedded: number;
  /** Sections still without one afterwards. */
  remaining: number;
  /** Why the run stopped before doing all it could, in words; null when it did not. */
  stoppedBecause: string | null;
}

/** About a minute and a half of OpenAI calls: inside the cron route's limit. */
export const BACKFILL_LIMIT = 200;

/** Sections stored without a search vector. document_chunk is global reference data. */
export async function countChunksWithoutVectors(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM document_chunk WHERE embedding IS NULL
  `;
  return Number(rows[0]?.n ?? 0);
}

/** OpenAI's words for an account it will not serve until credit is added. */
const NO_CREDIT_WORDS = /no credits remaining|exceeded your current quota/i;

/**
 * Why a call to OpenAI failed, for the person who can fix it: the account's
 * credit or key, which is what a failure that outlasts the retries comes down
 * to. Never the request, which carried a document's text.
 */
export function describeEmbedFailure(err: unknown): string {
  const e = err as {
    status?: number;
    code?: string | null;
    type?: string | null;
    message?: string;
    error?: { code?: string | null; type?: string | null };
  } | null;
  const code = e?.code ?? e?.error?.code ?? null;
  const type = e?.type ?? e?.error?.type ?? null;
  // Out of credit, by OpenAI's code, its type, or its words: production's
  // account answered "429 You have no credits remaining" (7 Nov 2026) without
  // the insufficient_quota code, and read as a rate limit nobody adds credit for.
  if (code === "insufficient_quota" || type === "insufficient_quota" || NO_CREDIT_WORDS.test(e?.message ?? "")) {
    return "OpenAI has no credit left on this account. Add credit, then run this again.";
  }
  if (e?.status === 401) return "OpenAI refused the API key (OPENAI_API_KEY). Check the key, then run this again.";
  if (e?.status === 429) return "OpenAI is limiting requests just now. Run this again later.";
  if (typeof e?.status === "number") return `OpenAI answered with an error (HTTP ${e.status}). Run this again later.`;
  return "OpenAI could not be reached. Run this again later.";
}

export async function embedMissingChunks(opts: { limit?: number } = {}): Promise<EmbedBackfillResult> {
  if (!isEmbedderConfigured()) {
    return {
      embedded: 0,
      remaining: await countChunksWithoutVectors(),
      stoppedBecause: "No OpenAI key is set (OPENAI_API_KEY), so nothing can be embedded.",
    };
  }
  const limit = Math.min(BACKFILL_LIMIT, Math.max(1, opts.limit ?? BACKFILL_LIMIT));
  // The oldest first: a document's sections in order.
  const pending = await prisma.$queryRaw<{ id: string; content: string }[]>`
    SELECT id, content FROM document_chunk
     WHERE embedding IS NULL
     ORDER BY created_at, source_doc_id, chunk_index
     LIMIT ${limit}
  `;
  const vectors: { id: string; literal: string }[] = [];
  let stoppedBecause: string | null = null;
  for (const c of pending) {
    try {
      const vec = await embed(c.content);
      vectors.push({ id: c.id, literal: `[${vec.join(",")}]` });
    } catch (err) {
      stoppedBecause = describeEmbedFailure(err);
      console.warn(`embed backfill: stopped after ${vectors.length} of ${pending.length} sections — ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }
  let embedded = 0;
  if (vectors.length > 0) {
    // Written as ingestion writes the table: through the admin connection.
    embedded = await withBreakglass(async (db) => {
      let n = 0;
      for (const v of vectors) {
        n += await db.$executeRaw`
          UPDATE document_chunk SET embedding = ${v.literal}::vector
           WHERE id = ${v.id}::uuid AND embedding IS NULL
        `;
      }
      return n;
    }, "embed backfill: search vectors for sections stored without one");
  }
  return { embedded, remaining: await countChunksWithoutVectors(), stoppedBecause };
}
