/**
 * OpenAI text-embedding-3-large at 1024 dimensions.
 *
 * Source: pallio_complete_vision_v3 §10.3. OpenAI is retained for the
 * embeddings layer only — Anthropic does not provide an embeddings
 * model. Every other AI call goes through `lib/ai/anthropic.client.ts`.
 *
 * Dimensions are clamped to 1024 (configurable per-call up to
 * 3072 native) — matches the `vector(1024)` columns we use in pgvector
 * for the document_chunk table. Changing dims requires a schema
 * migration, NOT just an env tweak.
 */
import OpenAI from "openai";

import { env } from "@/lib/env";

const EMBED_MODEL = "text-embedding-3-large";
const EMBED_DIMS = 1024;

let _client: OpenAI | null = null;

function client(): OpenAI {
  if (_client) return _client;
  const apiKey = env().OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Vector search requires the OpenAI embeddings API.",
    );
  }
  _client = new OpenAI({ apiKey, maxRetries: 4 });
  return _client;
}

/** True iff the API is configured. */
export function isEmbedderConfigured(): boolean {
  return Boolean(env().OPENAI_API_KEY);
}

/**
 * How long one call may take. The client's defaults (4 retries, a 10-minute
 * timeout) suit ingestion, which can wait out a rate limit. A lookup has a
 * person waiting: when the account had no credit left, every lookup that
 * reached the document search sat through four retries and then failed.
 */
export interface EmbedOptions {
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Embed a single string. Returns the 1024-dim vector. Truncated server
 * side at the model's 8191-token limit; long inputs raise the API's
 * native error.
 */
export async function embed(text: string, opts: EmbedOptions = {}): Promise<number[]> {
  const r = await client().embeddings.create(
    {
      model: EMBED_MODEL,
      dimensions: EMBED_DIMS,
      input: text,
    },
    {
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    },
  );
  const vec = r.data[0]?.embedding;
  if (!vec || vec.length !== EMBED_DIMS) {
    throw new Error(
      `embed: expected ${EMBED_DIMS}-dim vector, got ${vec?.length ?? "none"}`,
    );
  }
  return vec;
}

/**
 * Embeds one document's chunks, in order, for the document index, and stops
 * calling OpenAI once a chunk has failed: that chunk and every one after it
 * get null, are stored without a vector, and are still found by the word
 * search.
 *
 * Each call already retried four times. With the account out of credit
 * (4 Nov 2026) every chunk of a document sat through the same retries, six
 * seconds or more each, so a long document ran past the request's time limit
 * before it was stored. A failure that outlasts the retries will not clear
 * by the next chunk.
 */
export function documentChunkEmbedder(label: string): (text: string, index: number, total: number) => Promise<number[] | null> {
  let stopped = false;
  return async (text, index, total) => {
    if (stopped) return null;
    try {
      return await embed(text);
    } catch (err) {
      stopped = true;
      console.warn(
        `embed: stopped at chunk ${index + 1} of ${total} for ${label}; it and the rest are stored for word search only — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };
}

/** Batch embedder — single API round-trip per call. Useful at index time. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const r = await client().embeddings.create({
    model: EMBED_MODEL,
    dimensions: EMBED_DIMS,
    input: texts,
  });
  return r.data.map((d) => d.embedding);
}

export const EMBEDDING_DIMS = EMBED_DIMS;
