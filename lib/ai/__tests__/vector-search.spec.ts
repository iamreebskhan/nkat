/**
 * hybridSearch when the query cannot be embedded.
 *
 * On 4 Nov 2026 production's OpenAI account had no credit left. The
 * embedding threw, hybridSearch threw with it, and every lookup that reached
 * the document search failed with OpenAI's own message. Only the dense lane
 * needs OpenAI; the full-text lane is Postgres alone. These cases pin the
 * search to carry on with the words when the embedding fails.
 *
 * lib/db is a fake that tells the two lanes apart by their SQL and records
 * which ran.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ran: string[] = [];
vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: (strings: TemplateStringsArray) => {
      const sql = strings.join("¶");
      if (sql.includes("<=>")) {
        ran.push("dense");
        return Promise.resolve([
          { id: "c-dense", doc_id: "d1", content: "Dense hit.", cpt_codes_mentioned: ["99350"], policy_section: null, sim: 0.9 },
        ]);
      }
      if (sql.includes("ts_rank_cd")) {
        ran.push("sparse");
        return Promise.resolve([
          { id: "c-words", doc_id: "d2", content: "Place of service 12 (home) is allowed for 99350.", cpt_codes_mentioned: ["99350"], policy_section: null, rank: 0.4 },
        ]);
      }
      return Promise.reject(new Error(`the fake does not recognise this query: ${sql}`));
    },
  },
}));

const embed = vi.fn();
vi.mock("@/lib/ai/embedder", () => ({ embed: (...a: unknown[]) => embed(...a) }));

import { hybridSearch } from "../vector-search";

const input = { query: "pos_allowed for CPT 99350 in OH", payerId: "a0000000-0000-4000-8000-000000000303", state: "OH" };
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ran.length = 0;
  embed.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => warn.mockRestore());

describe("hybridSearch — a query that cannot be embedded", () => {
  it("is searched by its words instead of failing (REGRESSION: OpenAI out of credit)", async () => {
    embed.mockRejectedValue(new Error("429 You have no credits remaining. Add credits to continue using the API."));

    const hits = await hybridSearch(input);

    expect(ran).toEqual(["sparse"]);
    expect(hits.map((h) => h.chunkId)).toEqual(["c-words"]);
    expect(warn).toHaveBeenCalledWith(
      "vector-search: query not embedded, searching its words only — 429 You have no credits remaining. Add credits to continue using the API.",
    );
  });

  it("CONTROL: an embedded query still runs both lanes and merges them", async () => {
    embed.mockResolvedValue(new Array(1024).fill(0.01));

    const hits = await hybridSearch(input);

    expect(ran).toEqual(["dense", "sparse"]);
    expect(hits.map((h) => h.chunkId).sort()).toEqual(["c-dense", "c-words"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("asks the embedder for one retry and eight seconds, not the client's four and ten minutes", async () => {
    embed.mockResolvedValue(new Array(1024).fill(0.01));

    await hybridSearch(input);

    expect(embed).toHaveBeenCalledWith(input.query, { maxRetries: 1, timeoutMs: 8_000 });
  });
});
