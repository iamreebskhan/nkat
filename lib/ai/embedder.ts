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
  _client = new OpenAI({ apiKey });
  return _client;
}

/** True iff the API is configured. */
export function isEmbedderConfigured(): boolean {
  return Boolean(env().OPENAI_API_KEY);
}

/**
 * Embed a single string. Returns the 1024-dim vector. Truncated server
 * side at the model's 8191-token limit; long inputs raise the API's
 * native error.
 */
export async function embed(text: string): Promise<number[]> {
  const r = await client().embeddings.create({
    model: EMBED_MODEL,
    dimensions: EMBED_DIMS,
    input: text,
  });
  const vec = r.data[0]?.embedding;
  if (!vec || vec.length !== EMBED_DIMS) {
    throw new Error(
      `embed: expected ${EMBED_DIMS}-dim vector, got ${vec?.length ?? "none"}`,
    );
  }
  return vec;
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
