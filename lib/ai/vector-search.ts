/**
 * Hybrid retrieval over `document_chunk`: dense (pgvector cosine) + sparse
 * (Postgres full-text BM25-ish via ts_rank_cd) merged with reciprocal-rank
 * fusion.
 *
 * Source: pallio_complete_vision_v3 §10.3 ("Hybrid retrieval").
 *
 * Why hybrid? Dense embeddings nail semantic recall (rephrasings, near-
 * synonyms) but miss exact-match anchors like CPT codes; lexical search
 * is the opposite. We need both for billing rules where the literal
 * code "99349" matters AND the surrounding policy language matters.
 *
 * Filters: every retrieval narrows by `payer_id` + `state` so we never
 * surface an Aetna-CA chunk for a Humana-OH question.
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { embed } from "./embedder";

export interface ChunkHit {
  chunkId: string;
  docId: string;
  content: string;
  cptCodesMentioned: string[];
  policySection: string | null;
  /** Reciprocal-rank-fusion score; higher is better. */
  score: number;
}

export interface VectorSearchInput {
  query: string;
  /** Required — never search across all payers. */
  payerId: string;
  /** Required — never search across all states. */
  state: string;
  /** Total results returned after RRF merge. Capped at 20. */
  topK?: number;
}

const TOP_K_PER_LANE = 10;
const RRF_K = 60; // standard RRF damping constant

/**
 * Hybrid retrieval: pgvector cosine + Postgres FTS, merged with RRF.
 *
 * Returns up to `topK` chunks (default 5). The caller hands these to
 * the synthesizer; an empty result is the trigger to refuse the query.
 *
 * ## Why client uploads are excluded
 *
 * Looking up Aetna / OH / 99213 returned "covered ... with no prior
 * authorization required", cited to a document called "Aetna Ohio
 * supplemental coverage note 2026". The quote was real. The document was
 * real. It is `upload://aetna-99213.txt` — a text file somebody pasted in
 * through /api/rulebook/upload while testing, titled "Aetna OH 99213
 * supplemental note".
 *
 * It sat in this corpus beside Aetna's actual published policies and outranked
 * them, and it contradicted the library's own evidenced position: a seed
 * enumerated all 919 live Aetna Clinical Policy Bulletins and concluded Aetna
 * publishes no code-level determination for these codes. A pasted file was
 * overruling that, in front of a biller, with the same authority as a payer
 * PDF.
 *
 * Two things are wrong with letting uploads answer here, and neither is about
 * that one file:
 *
 *   - The citation cannot be checked. A `upload://` URL opens nothing. An
 *     answer whose evidence a biller cannot read is not a cited answer.
 *   - Neither source_document nor document_chunk carries an org_id, so an
 *     upload is GLOBAL. One practice's pasted file answers every other
 *     practice's question about that payer.
 *
 * The upload feature is deliberate — a practice receives a payer letter and
 * wants it read. That is worth having, and it needs uploads to be scoped to
 * the org that supplied them, which is a schema change. Until then they do
 * not belong in a shared, cited corpus.
 */
export async function hybridSearch(input: VectorSearchInput): Promise<ChunkHit[]> {
  const topK = Math.min(20, Math.max(1, input.topK ?? 5));

  // 1. Dense lane — embed the query, run cosine on document_chunk.embedding.
  const queryVec = await embed(input.query);
  const denseRows = await prisma.$queryRaw<
    {
      id: string;
      doc_id: string;
      content: string;
      cpt_codes_mentioned: string[];
      policy_section: string | null;
      sim: number;
    }[]
  >`
    SELECT
      dc.id, dc.source_doc_id AS doc_id, dc.content,
      dc.codes_mentioned AS cpt_codes_mentioned, dc.policy_section,
      1 - (dc.embedding <=> ${vectorLiteral(queryVec)}::vector) AS sim
    FROM document_chunk dc
    JOIN source_document sd ON sd.id = dc.source_doc_id
    WHERE dc.payer_id = ${input.payerId}::uuid
      AND dc.state = ${input.state}
      AND dc.embedding IS NOT NULL
      AND sd.document_type <> 'client_upload'
    ORDER BY dc.embedding <=> ${vectorLiteral(queryVec)}::vector
    LIMIT ${TOP_K_PER_LANE}
  `;

  // 2. Sparse lane — Postgres FTS with same payer+state filter.
  const sparseRows = await prisma.$queryRaw<
    {
      id: string;
      doc_id: string;
      content: string;
      cpt_codes_mentioned: string[];
      policy_section: string | null;
      rank: number;
    }[]
  >`
    SELECT
      dc.id, dc.source_doc_id AS doc_id, dc.content,
      dc.codes_mentioned AS cpt_codes_mentioned, dc.policy_section,
      ts_rank_cd(to_tsvector('english', dc.content), plainto_tsquery('english', ${input.query})) AS rank
    FROM document_chunk dc
    JOIN source_document sd ON sd.id = dc.source_doc_id
    WHERE dc.payer_id = ${input.payerId}::uuid
      AND dc.state = ${input.state}
      AND to_tsvector('english', dc.content) @@ plainto_tsquery('english', ${input.query})
      AND sd.document_type <> 'client_upload'
    ORDER BY rank DESC
    LIMIT ${TOP_K_PER_LANE}
  `;

  // 3. Reciprocal-rank fusion. score(d) = Σ 1 / (k + rank_d) for each lane d appears in.
  const merged = new Map<string, ChunkHit & { ranks: number[] }>();
  for (const [rank, row] of denseRows.entries()) {
    upsertRank(merged, row, rank);
  }
  for (const [rank, row] of sparseRows.entries()) {
    upsertRank(merged, row, rank);
  }

  return Array.from(merged.values())
    .map(({ ranks, ...hit }) => ({
      ...hit,
      score: ranks.reduce((acc, r) => acc + 1 / (RRF_K + r), 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function upsertRank(
  map: Map<string, ChunkHit & { ranks: number[] }>,
  row: {
    id: string;
    doc_id: string;
    content: string;
    cpt_codes_mentioned: string[];
    policy_section: string | null;
  },
  rank: number,
): void {
  const existing = map.get(row.id);
  if (existing) {
    existing.ranks.push(rank);
  } else {
    map.set(row.id, {
      chunkId: row.id,
      docId: row.doc_id,
      content: row.content,
      cptCodesMentioned: row.cpt_codes_mentioned ?? [],
      policySection: row.policy_section,
      score: 0,
      ranks: [rank],
    });
  }
}

/**
 * Format a number[] as a pgvector literal — `[0.123,0.456,...]`. We use
 * Prisma.sql() directly because parameter binding through $queryRaw would
 * coerce arrays to JSON, and pgvector won't cast JSON → vector.
 */
function vectorLiteral(vec: number[]): Prisma.Sql {
  return Prisma.sql`'[${Prisma.raw(vec.join(","))}]'`;
}
