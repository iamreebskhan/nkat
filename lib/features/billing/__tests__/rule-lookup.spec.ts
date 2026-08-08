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
// Untyped like the other mocks — a typed empty-array initializer would
// infer never[] and reject the benchmark fixtures below.
const mockFetchBenchmarks = vi.fn();
vi.mock("../payer-rule.repository", () => ({
  fetchPayerRule: (...a: unknown[]) => mockFetchPayerRule(...a),
  fetchBenchmarkRules: (...a: unknown[]) => mockFetchBenchmarks(...a),
  getPayerType: vi.fn(),
  listPayers: vi.fn(),
}));

const mockFetchOrgRule = vi.fn();
vi.mock("@/lib/features/rulebook/org-rule.repository", () => ({
  fetchOrgRule: (...a: unknown[]) => mockFetchOrgRule(...a),
  upsertOrgRule: vi.fn(),
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

/**
 * Option 3 — the org's own rulebook answers first, with the global
 * library shown alongside for comparison.
 *
 * The bug these lock down: the lookup used to read the global
 * `payer_rule` library ONLY, so an org that had documented a payer in
 * their own rulebook still got "Unknown" at the point of care.
 */
describe("lookupRule org-first resolution", () => {
  const PAYER = "22222222-2222-4222-8222-222222222222";
  const CALLER_ORG = "33333333-3333-4333-8333-333333333333";

  const orgRow = (over: Record<string, unknown> = {}) => ({
    rowId: "org-row-1",
    attribute: "covered",
    value: { answer: "Covered — confirmed with Humana rep 2026-07-14." },
    coverageStatus: "covered",
    confidence: 0.6,
    origin: "analyst",
    sourceQuote: "Rep confirmed 99350 pays under the home-visit benefit.",
    expiresAt: null,
    lastEditedAt: new Date("2026-07-14"),
    sourceAttestationId: "att-1",
    sourcePayerRuleId: null,
    ...over,
  });

  const globalRow = (over: Record<string, unknown> = {}) => ({
    ruleId: "r-global",
    attribute: "covered",
    value: { answer: "Not covered per published policy." },
    coverageStatus: "not_covered",
    confidence: 0.9,
    effectiveDate: new Date("2026-01-01"),
    expirationDate: null,
    sourceDocId: "d-global",
    sourceUrl: "https://cms.example.gov/pfs.pdf",
    sourceQuote: "Home visit codes are not separately payable.",
    sourcePage: 4,
    ...over,
  });

  const req = {
    orgId: CALLER_ORG,
    payerId: PAYER,
    state: "OH",
    cptCode: "99350",
    attribute: "covered" as const,
  };

  it("prefers the org rulebook over the global library", async () => {
    mockFetchOrgRule.mockResolvedValue(orgRow());
    mockFetchPayerRule.mockResolvedValue(globalRow());

    const r = await lookupRule(req);

    expect(r.status).toBe("ok");
    expect(r.source).toBe("org_rulebook");
    expect(r.coverageStatus).toBe("covered");
    expect(r.answer).toContain("your rulebook");
    // Never reaches the AI tier when a library answered.
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("scopes the org read to the CALLER's org", async () => {
    mockFetchOrgRule.mockResolvedValue(orgRow());
    mockFetchPayerRule.mockResolvedValue(null);

    await lookupRule(req);

    expect(mockFetchOrgRule).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: CALLER_ORG, code: "99350" }),
    );
  });

  it("carries the global library alongside as comparison", async () => {
    mockFetchOrgRule.mockResolvedValue(orgRow());
    mockFetchPayerRule.mockResolvedValue(globalRow());

    const r = await lookupRule(req);

    expect(r.comparison).not.toBeNull();
    expect(r.comparison?.scope).toBe("global_library");
    expect(r.comparison?.coverageStatus).toBe("not_covered");
    expect(r.comparison?.citation?.verbatimQuote).toContain("not separately payable");
  });

  it("flags a conflict when the two libraries disagree", async () => {
    mockFetchOrgRule.mockResolvedValue(orgRow({ coverageStatus: "covered" }));
    mockFetchPayerRule.mockResolvedValue(
      globalRow({ coverageStatus: "not_covered" }),
    );

    const r = await lookupRule(req);

    expect(r.conflict).toBe(true);
    // The org still wins — the flag surfaces the divergence, it
    // doesn't override the answer.
    expect(r.coverageStatus).toBe("covered");
  });

  it("does not flag a conflict when they agree", async () => {
    mockFetchOrgRule.mockResolvedValue(orgRow({ coverageStatus: "covered" }));
    mockFetchPayerRule.mockResolvedValue(globalRow({ coverageStatus: "covered" }));

    const r = await lookupRule(req);

    expect(r.conflict).toBe(false);
  });

  it("does not flag a conflict against a sub-threshold global row", async () => {
    mockFetchOrgRule.mockResolvedValue(orgRow({ coverageStatus: "covered" }));
    mockFetchPayerRule.mockResolvedValue(
      globalRow({ coverageStatus: "not_covered", confidence: 0.2 }),
    );

    const r = await lookupRule(req);

    // A 0.2-confidence row isn't a position worth contradicting, but
    // it's still shown so the biller can chase it down.
    expect(r.conflict).toBe(false);
    expect(r.comparison?.coverageStatus).toBe("not_covered");
  });

  it("falls back to the global library when the org has no row", async () => {
    mockFetchOrgRule.mockResolvedValue(null);
    mockFetchPayerRule.mockResolvedValue(globalRow());

    const r = await lookupRule(req);

    expect(r.source).toBe("structured_rule");
    expect(r.coverageStatus).toBe("not_covered");
    expect(r.comparison).toBeNull();
    expect(r.conflict).toBe(false);
  });

  it("never reads an org rulebook when no orgId is supplied", async () => {
    mockFetchOrgRule.mockResolvedValue(orgRow());
    mockFetchPayerRule.mockResolvedValue(globalRow());

    const r = await lookupRule({ ...req, orgId: undefined });

    expect(mockFetchOrgRule).not.toHaveBeenCalled();
    expect(r.source).toBe("structured_rule");
  });

  it("surfaces a weak global rule as comparison even when the answer is unknown", async () => {
    mockFetchOrgRule.mockResolvedValue(null);
    mockFetchPayerRule.mockResolvedValue(globalRow({ confidence: 0.1 }));
    mockHybridSearch.mockResolvedValue([]);
    mockSynthesize.mockResolvedValue({ refused: true, citation: null, answer: "", raw: "" });

    const r = await lookupRule(req);

    expect(r.status).toBe("unknown");
    expect(r.comparison?.coverageStatus).toBe("not_covered");
    expect(r.comparison?.confidence).toBe(0.1);
  });
});

/**
 * Answer prose. The JSONB payload shape varies by attribute, and the
 * old renderer just JSON.stringify'd it, so billers saw answers like
 * `covered. {"covered":true}` in the result panel.
 */
describe("lookupRule answer rendering", () => {
  const base = {
    payerId: "22222222-2222-4222-8222-222222222222",
    state: "OH",
    cptCode: "99349",
    attribute: "covered" as const,
  };

  const globalWith = (value: Record<string, unknown>) => ({
    ruleId: "r", attribute: "covered", value, coverageStatus: "covered",
    confidence: 0.9, effectiveDate: new Date("2026-01-01"), expirationDate: null,
    sourceDocId: "d", sourceUrl: null, sourceQuote: null, sourcePage: null,
  });

  it("drops the redundant covered flag instead of dumping JSON", async () => {
    mockFetchOrgRule.mockResolvedValue(null);
    mockFetchPayerRule.mockResolvedValue(globalWith({ covered: true }));

    const r = await lookupRule(base);

    expect(r.answer).toBe("For CPT 99349: covered.");
    expect(r.answer).not.toContain("{");
  });

  it("prefers an explicit answer string", async () => {
    mockFetchOrgRule.mockResolvedValue(null);
    mockFetchPayerRule.mockResolvedValue(
      globalWith({ covered: true, answer: "Covered with modifier 95." }),
    );

    const r = await lookupRule(base);

    expect(r.answer).toBe("For CPT 99349: covered. Covered with modifier 95.");
  });

  it("renders remaining keys as readable pairs, notes unlabelled", async () => {
    mockFetchOrgRule.mockResolvedValue(null);
    mockFetchPayerRule.mockResolvedValue(
      globalWith({
        covered: false,
        note: "Prior authorization required.",
        units_per_year: 12,
        modifier_required: true,
      }),
    );

    const r = await lookupRule(base);

    expect(r.answer).toContain("Prior authorization required.");
    expect(r.answer).toContain("Units per year: 12");
    expect(r.answer).toContain("Modifier required: yes");
    expect(r.answer).not.toContain("{");
  });
});

/**
 * Benchmark fallback. Commercial payers publish no fee schedule, so a
 * lookup for one used to return a bare "Unknown" and throw away what the
 * library did know. It now returns the reference a biller would look up
 * by hand — clearly labelled as NOT that payer's rule.
 */
describe("lookupRule benchmark fallback", () => {
  const req = {
    payerId: "44444444-4444-4444-8444-444444444444",
    state: "OH",
    cptCode: "99349",
    attribute: "covered" as const,
  };

  const benchmark = {
    ruleId: "b1", attribute: "covered", value: { answer: "Paid separately." },
    coverageStatus: "covered", confidence: 0.95,
    effectiveDate: new Date("2026-07-01"), expirationDate: null,
    sourceDocId: "d", sourceUrl: null,
    sourceQuote: "99349 | Home/res vst est mod mdm 40 | status code A",
    sourcePage: null, isStatewide: false,
    payerName: "Traditional Medicare (Part B)", payerType: "medicare_mac",
  };

  it("returns a labelled benchmark when the payer has no rule of its own", async () => {
    mockFetchOrgRule.mockResolvedValue(null);
    mockFetchPayerRule.mockResolvedValue(null);
    mockFetchBenchmarks.mockResolvedValue([benchmark]);
    mockHybridSearch.mockResolvedValue([]);
    mockSynthesize.mockResolvedValue({ refused: true, citation: null, answer: "", raw: "" });

    const r = await lookupRule(req);

    // Status stays unknown — we genuinely do not know THIS payer's rule.
    expect(r.status).toBe("unknown");
    expect(r.comparison?.scope).toBe("benchmark");
    expect(r.comparison?.answer).toContain("Traditional Medicare");
    expect(r.comparison?.answer).toContain("not this payer's rule");
    // Never presented as the payer's own confidence.
    expect(r.comparison?.confidence).toBe(0);
  });

  it("excludes the requested payer from its own benchmark", async () => {
    mockFetchOrgRule.mockResolvedValue(null);
    mockFetchPayerRule.mockResolvedValue(null);
    mockFetchBenchmarks.mockResolvedValue([]);
    mockHybridSearch.mockResolvedValue([]);
    mockSynthesize.mockResolvedValue({ refused: true, citation: null, answer: "", raw: "" });

    await lookupRule(req);

    expect(mockFetchBenchmarks).toHaveBeenCalledWith(
      expect.objectContaining({ excludePayerId: req.payerId, code: "99349", state: "OH" }),
    );
  });

  it("prefers a real global rule over a benchmark", async () => {
    mockFetchOrgRule.mockResolvedValue(null);
    mockFetchPayerRule.mockResolvedValue({
      ruleId: "r", attribute: "covered", value: {}, coverageStatus: "varies",
      confidence: 0.2, effectiveDate: new Date("2026-01-01"), expirationDate: null,
      sourceDocId: "d", sourceUrl: null, sourceQuote: "weak but real", sourcePage: null,
      isStatewide: false,
    });
    mockFetchBenchmarks.mockResolvedValue([benchmark]);
    mockHybridSearch.mockResolvedValue([]);
    mockSynthesize.mockResolvedValue({ refused: true, citation: null, answer: "", raw: "" });

    const r = await lookupRule(req);

    expect(r.comparison?.scope).toBe("global_library");
  });
});
