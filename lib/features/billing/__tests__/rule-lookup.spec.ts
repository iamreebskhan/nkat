/**
 * Unit tests for the rule-lookup orchestrator decision flow.
 *
 * Deterministic — every external dep is mocked. The contract under
 * test is the §18.6 flow: SQL → vector → Claude → citation check →
 * unknown floor.
 *
 * Live API exercises happen in the gold-standard eval (gated by
 * EVAL=1) and the integration suite (later phase).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: () => ({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://x",
    JWT_SECRET: "x".repeat(32),
    JWT_EXPIRES_IN: "7d",
    COOKIE_NAME: "pallio_session",
    ANTHROPIC_API_KEY: "test",
    OPENAI_API_KEY: "test",
    EMAIL_FROM_ADDRESS: "no-reply@pallio.local",
    UPLOAD_DIR: "./var/uploads",
    MAX_FILE_SIZE_MB: 2000,
    CHUNK_SIZE_MB: 5,
    APP_BASE_URL: "http://localhost:3000",
  }),
}));

vi.mock("@/lib/db", () => ({
  prisma: {} as never,
  withOrgContext: vi.fn(),
}));

const mockFetchPayerRule = vi.fn();
vi.mock("../payer-rule.repository", () => ({
  fetchPayerRule: (...a: unknown[]) => mockFetchPayerRule(...a),
  getPayerType: vi.fn(),
  listPayers: vi.fn(),
}));

const mockHybridSearch = vi.fn();
vi.mock("@/lib/ai/vector-search", () => ({
  hybridSearch: (...a: unknown[]) => mockHybridSearch(...a),
}));

const mockSynthesize = vi.fn();
const mockParseRuleQuery = vi.fn();
vi.mock("@/lib/ai/anthropic.client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/ai/anthropic.client")
  >("@/lib/ai/anthropic.client");
  return {
    ...actual,
    isAnthropicConfigured: () => true,
    parseRuleQuery: (...a: unknown[]) => mockParseRuleQuery(...a),
    synthesizeRuleAnswer: (...a: unknown[]) => mockSynthesize(...a),
  };
});

vi.mock("@/lib/ai/embedder", () => ({
  isEmbedderConfigured: () => true,
  embed: vi.fn(),
  embedBatch: vi.fn(),
  EMBEDDING_DIMS: 1024,
}));

import { lookupRule } from "../rule-lookup.service";

const ORG = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.clearAllMocks();
});

describe("lookupRule decision flow (vision §18.6)", () => {
  it("returns needs_clarification when payer/state/code all missing", async () => {
    const r = await lookupRule({});
    expect(r.status).toBe("needs_clarification");
    expect(r.missing).toEqual(["payer", "state", "cptCode"]);
  });

  it("returns structured_rule + citation when SQL hit ≥ 0.5 confidence", async () => {
    mockFetchPayerRule.mockResolvedValue({
      ruleId: "r1",
      attribute: "covered",
      value: { answer: "Covered with 95 modifier." },
      coverageStatus: "covered",
      confidence: 0.95,
      effectiveDate: new Date("2024-01-01"),
      expirationDate: null,
      sourceDocId: "d1",
      sourceUrl: "https://payer.example.com/policy.pdf",
      sourceQuote: "CPT 99349 is covered when modifier 95 is appended.",
      sourcePage: 12,
    });

    const r = await lookupRule({
      payerId: ORG,
      state: "OH",
      cptCode: "99349",
      attribute: "covered",
    });

    expect(r.status).toBe("ok");
    expect(r.source).toBe("structured_rule");
    expect(r.coverageStatus).toBe("covered");
    expect(r.confidence).toBe(0.95);
    expect(r.citation?.verbatimQuote).toContain("99349");
    expect(r.citation?.documentUrl).toBe("https://payer.example.com/policy.pdf");
    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(mockHybridSearch).not.toHaveBeenCalled();
  });

  it("falls back to RAG when SQL hit is below MIN_SQL_CONFIDENCE", async () => {
    mockFetchPayerRule.mockResolvedValue({
      ruleId: "r1",
      attribute: "covered",
      value: {},
      coverageStatus: "varies",
      confidence: 0.2,
      effectiveDate: new Date("2024-01-01"),
      expirationDate: null,
      sourceDocId: "d1",
      sourceUrl: null,
      sourceQuote: null,
      sourcePage: null,
    });
    mockHybridSearch.mockResolvedValue([
      { chunkId: "c1", docId: "d1", content: "Aetna covers 99349 telehealth.", cptCodesMentioned: ["99349"], policySection: null, score: 1 },
    ]);
    mockSynthesize.mockResolvedValue({
      answer: "Aetna covers 99349 telehealth in Ohio.",
      citation: {
        documentName: "Aetna Clinical Policy Bulletin",
        effectiveDate: "2025-01-01",
        verbatimQuote: "CPT 99349 telehealth is covered when modifier 95 is appended.",
      },
      refused: false,
      raw: "ok",
    });

    const r = await lookupRule({
      payerId: ORG,
      state: "OH",
      cptCode: "99349",
      attribute: "telehealth",
    });

    expect(r.source).toBe("ai_synthesized");
    expect(r.confidence).toBe(0.4);
    expect(r.citation?.documentName).toBe("Aetna Clinical Policy Bulletin");
    expect(mockHybridSearch).toHaveBeenCalledOnce();
    expect(mockSynthesize).toHaveBeenCalledOnce();
  });

  it("returns unknown when synthesizer refuses", async () => {
    mockFetchPayerRule.mockResolvedValue(null);
    mockHybridSearch.mockResolvedValue([]);
    mockSynthesize.mockResolvedValue({
      answer: "NO_RULE_FOUND",
      citation: null,
      refused: true,
      raw: "NO_RULE_FOUND",
    });

    const r = await lookupRule({
      payerId: ORG,
      state: "VT",
      cptCode: "99350",
      attribute: "covered",
    });

    expect(r.status).toBe("unknown");
    expect(r.source).toBe("unknown");
    expect(r.confidence).toBe(0);
    expect(r.citation).toBeNull();
    expect(r.answer).toContain("No confirmed rule");
  });

  it("returns unknown even if model produces prose without a citation", async () => {
    mockFetchPayerRule.mockResolvedValue(null);
    mockHybridSearch.mockResolvedValue([]);
    // Model talks but never quotes — citation parser drops the answer.
    mockSynthesize.mockResolvedValue({
      answer: "I think it's probably covered.",
      citation: null,
      refused: true,
      raw: "I think it's probably covered.",
    });

    const r = await lookupRule({
      payerId: ORG,
      state: "VT",
      cptCode: "99350",
      attribute: "covered",
    });

    expect(r.status).toBe("unknown");
    expect(r.source).toBe("unknown");
  });
});
