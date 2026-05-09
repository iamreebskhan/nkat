/**
 * BedrockSynthesisProvider — LLM-backed synthesizer with hallucination guards.
 *
 * The actual @aws-sdk/client-bedrock-runtime dependency stays out of this
 * module; we accept an injectable client surface so unit tests stub the
 * network without pulling AWS SDK into Jest. Production wiring passes a real
 * BedrockRuntimeClient instance whose `invokeModel(...)` matches our shape.
 *
 * Hallucination guard: after the model returns a narrative, we verify every
 * code (CPT/HCPCS), URL, and source_doc_id mentioned in the narrative was
 * present in the input findings. If anything new appears, we mark
 * `hallucination_risk = true` and the caller's UI falls back to the
 * deterministic provider's output.
 */
import { Injectable } from '@nestjs/common';
import type { CitationDto, FindingDto } from '../lookup/dto/lookup-response.dto';
import {
  SynthesisRefusedError,
  type SynthesisProvider,
  type SynthesisRequest,
  type SynthesisResult,
} from './synthesis-types';

/** Minimal Bedrock-shaped client surface. */
export interface BedrockClient {
  invokeModel(args: {
    modelId: string;
    contentType: 'application/json';
    body: string; // serialized JSON request body for the chosen model
  }): Promise<{ body: Uint8Array; status: number }>;
}

export interface BedrockProviderOptions {
  modelId: string;
  /** System prompt prepended on every request. */
  systemPrompt: string;
  /** Hard token cap for the response. */
  maxTokens: number;
  /** Refusal threshold: synthesis result narrative must include at least one finding citation URL or it's discarded. */
  requireCitationInNarrative: boolean;
}

const DEFAULT_OPTIONS: BedrockProviderOptions = {
  modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  systemPrompt:
    'You are a billing-rule explainer. Summarize the findings in 4–8 sentences for a medical biller. Quote nothing. Reference codes by code only. Never introduce a code, dollar value, or URL not present in the findings. End with the citations as a separate block.',
  maxTokens: 600,
  requireCitationInNarrative: false,
};

@Injectable()
export class BedrockSynthesisProvider implements SynthesisProvider {
  readonly name = 'bedrock';
  private readonly opts: BedrockProviderOptions;

  constructor(
    private readonly client: BedrockClient,
    opts?: Partial<BedrockProviderOptions>,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    if (req.findings.length === 0) {
      throw new SynthesisRefusedError('no_findings', 'No findings to synthesize.');
    }
    const minConfidence = req.findings.reduce((m, f) => Math.min(m, f.confidence ?? 1), 1);
    if (minConfidence < 0.5) {
      throw new SynthesisRefusedError(
        'low_confidence',
        `Lowest finding confidence ${minConfidence.toFixed(2)} below threshold`,
      );
    }

    const userMessage = buildUserMessage(req);
    const requestBody = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: this.opts.maxTokens,
      system: this.opts.systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: userMessage }] }],
    });

    const res = await this.client.invokeModel({
      modelId: this.opts.modelId,
      contentType: 'application/json',
      body: requestBody,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Bedrock invokeModel returned HTTP ${res.status}`);
    }
    const decoded = new TextDecoder().decode(res.body);
    const parsed = JSON.parse(decoded) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const narrative = (parsed.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
      .trim();
    if (narrative.length === 0) {
      throw new SynthesisRefusedError('no_findings', 'Bedrock returned an empty narrative.');
    }

    const allowedTokens = collectAllowedTokens(req.findings);
    const hallucination = detectHallucinations(narrative, allowedTokens);
    const citations = dedupeCitations(req.findings.flatMap((f) => f.citations ?? []));
    const counts = { critical: 0, warning: 0, info: 0, ok: 0 } as const;
    const severitySummary = { ...counts } as Record<keyof typeof counts, number>;
    for (const f of req.findings)
      severitySummary[f.severity] = (severitySummary[f.severity] ?? 0) + 1;

    return {
      narrative,
      citations,
      severity_summary: severitySummary,
      provider: this.name,
      min_confidence: minConfidence,
      hallucination_risk: hallucination,
    };
  }
}

// ----- Pure helpers (exported for testing) --------------------------------

export function buildUserMessage(req: SynthesisRequest): string {
  const head = [
    `Payer: ${req.payer_id}`,
    `State: ${req.state}`,
    `Product line: ${req.product_line}`,
    `Date of service: ${req.date_of_service}`,
    `Audience: ${req.audience}`,
    '',
    'Findings (verbatim, do not invent additional codes/values/URLs):',
  ].join('\n');
  const bullets = req.findings.map(
    (f, i) =>
      `  ${i + 1}. [${f.severity.toUpperCase()}] ${f.carc_class} — ${f.title}: ${f.detail || ''}` +
      (f.recommendation ? ` (Rec: ${f.recommendation})` : ''),
  );
  return [head, ...bullets].join('\n');
}

export interface AllowedTokens {
  codes: Set<string>;
  urls: Set<string>;
  source_doc_ids: Set<string>;
}

const CODE_RE = /\b(?:[A-Z]\d{4}|[1-9]\d{4})\b/g; // J9035, 99497, etc.
const URL_RE = /https?:\/\/[^\s)\]]+/g;
const DOC_ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

export function collectAllowedTokens(findings: FindingDto[]): AllowedTokens {
  const codes = new Set<string>();
  const urls = new Set<string>();
  const docIds = new Set<string>();
  for (const f of findings) {
    const blob = `${f.title} ${f.detail} ${f.recommendation ?? ''}`;
    for (const m of blob.matchAll(CODE_RE)) codes.add(m[0]);
    for (const c of f.citations ?? []) {
      if (c.source_url) urls.add(c.source_url);
      if (c.source_doc_id) docIds.add(c.source_doc_id);
      if (c.verbatim_quote) {
        for (const m of c.verbatim_quote.matchAll(CODE_RE)) codes.add(m[0]);
      }
    }
  }
  return { codes, urls, source_doc_ids: docIds };
}

/** Strip trailing sentence punctuation; URLs swallow ".,;:!?" when next to them. */
function trimTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?]+$/, '');
}

export function detectHallucinations(narrative: string, allowed: AllowedTokens): boolean {
  for (const m of narrative.matchAll(CODE_RE)) {
    if (!allowed.codes.has(m[0])) return true;
  }
  for (const m of narrative.matchAll(URL_RE)) {
    if (!allowed.urls.has(trimTrailingPunct(m[0]))) return true;
  }
  for (const m of narrative.matchAll(DOC_ID_RE)) {
    if (!allowed.source_doc_ids.has(m[0].toLowerCase())) return true;
  }
  return false;
}

function dedupeCitations(cites: CitationDto[]): CitationDto[] {
  const seen = new Set<string>();
  const out: CitationDto[] = [];
  for (const c of cites) {
    const key = `${c.source_doc_id}|${c.source_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
