/**
 * embed() hands a caller's retry and timeout limits to the OpenAI SDK, and
 * leaves the client's defaults alone for a caller that sets none (ingestion,
 * which can wait out a rate limit).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: () => ({ OPENAI_API_KEY: "test" }) }));

const create = vi.fn(async () => ({ data: [{ embedding: new Array(1024).fill(0) }] }));
const constructed: unknown[] = [];
vi.mock("openai", () => ({
  default: class {
    embeddings = { create };
    constructor(opts: unknown) {
      constructed.push(opts);
    }
  },
}));

import { embed } from "../embedder";

describe("embed — per-call limits", () => {
  it("passes a lookup's one retry and eight seconds to the SDK", async () => {
    await embed("pos_allowed for CPT 99350 in OH", { maxRetries: 1, timeoutMs: 8_000 });
    expect(create).toHaveBeenLastCalledWith(
      { model: "text-embedding-3-large", dimensions: 1024, input: "pos_allowed for CPT 99350 in OH" },
      { maxRetries: 1, timeout: 8_000 },
    );
  });

  it("sends no limits of its own when the caller sets none", async () => {
    await embed("chunk text");
    expect(create).toHaveBeenLastCalledWith(
      { model: "text-embedding-3-large", dimensions: 1024, input: "chunk text" },
      {},
    );
    // The client keeps its own default of four retries.
    expect(constructed).toEqual([{ apiKey: "test", maxRetries: 4 }]);
  });
});
