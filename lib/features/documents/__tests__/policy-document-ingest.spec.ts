/**
 * A policy document whose chunks OpenAI will not embed is still stored, after
 * one failed call rather than one per chunk.
 *
 * With the account out of credit (4 Nov 2026), each chunk sat through the
 * client's four retries, six seconds or more, so a long document ran past
 * the request's time limit. The chunks are stored without vectors and the
 * word search still reads them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: () => ({ OPENAI_API_KEY: "test" }) }));

const create = vi.fn();
vi.mock("openai", () => ({
  default: class {
    embeddings = { create };
  },
}));

const statements: string[] = [];
vi.mock("@/lib/db", () => ({
  withOrgContext: vi.fn(),
  withBreakglass: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({
      $queryRaw: async (s: TemplateStringsArray) => {
        statements.push(s.join("¶"));
        return [{ id: "doc-1" }];
      },
      $executeRaw: async (s: TemplateStringsArray) => {
        statements.push(s.join("¶"));
        return 1;
      },
    }),
}));

import { ingestPolicyDocument } from "../ingestion.service";

// Five sections chunkText keeps apart: each is close to its 1,200-character limit.
const letter = Array.from({ length: 5 }, (_, i) => `Section ${i + 1}. ${"Prior authorization applies. ".repeat(38)}`).join("\n\n");

const ingest = () =>
  ingestPolicyDocument({ payerId: null, state: "OH", url: "upload://letter.txt", title: "Payer letter", text: letter });

const chunkInserts = () => statements.filter((s) => s.includes("INSERT INTO document_chunk"));

beforeEach(() => {
  statements.length = 0;
  create.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ingestPolicyDocument — OpenAI out of credit", () => {
  it("asks OpenAI once, then stores every chunk for word search", async () => {
    create.mockRejectedValue(new Error("429 You have no credits remaining."));

    const r = await ingest();

    expect(r).toEqual({ sourceDocId: "doc-1", chunkCount: 5, embedded: false });
    // It asked once per chunk, each after the client's own retries.
    expect(create).toHaveBeenCalledTimes(1);
    expect(chunkInserts()).toHaveLength(5);
    expect(chunkInserts().some((s) => s.includes("embedding"))).toBe(false);
  });

  it("keeps the vectors it got before the failure", async () => {
    create
      .mockResolvedValueOnce({ data: [{ embedding: new Array(1024).fill(0) }] })
      .mockRejectedValue(new Error("429 You have no credits remaining."));

    const r = await ingest();

    expect(r.embedded).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(chunkInserts().map((s) => s.includes("embedding"))).toEqual([true, false, false, false, false]);
  });

  it("CONTROL: embeds every chunk while OpenAI answers", async () => {
    create.mockResolvedValue({ data: [{ embedding: new Array(1024).fill(0) }] });

    const r = await ingest();

    expect(r).toEqual({ sourceDocId: "doc-1", chunkCount: 5, embedded: true });
    expect(create).toHaveBeenCalledTimes(5);
    expect(chunkInserts().every((s) => s.includes("embedding"))).toBe(true);
  });
});
