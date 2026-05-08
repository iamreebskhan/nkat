/**
 * Synthesis layer types.
 *
 * The synthesis layer takes the structured findings produced by the lookup
 * orchestrator and turns them into a brief plain-English narrative — WITHOUT
 * dropping any citation. Behind a feature flag (default off); the
 * structured findings are still the source of truth.
 */
import type { CitationDto, FindingDto, Severity } from '../lookup/dto/lookup-response.dto';

export interface SynthesisRequest {
  request_id: string;
  payer_id: string;
  state: string;
  product_line: string;
  date_of_service: string;
  findings: FindingDto[];
  /** Hint about the audience — billers want different phrasing than analysts. */
  audience: 'biller' | 'manager' | 'analyst';
}

export interface SynthesisResult {
  narrative: string;
  /** Citations preserved end-to-end from input findings; same shape, no synthesis. */
  citations: CitationDto[];
  /** Severities that contributed, sorted critical → ok. */
  severity_summary: Record<Severity, number>;
  /** Provider that produced this output (for telemetry + caching). */
  provider: string;
  /**
   * Minimum confidence among the contributing findings. We never present
   * synthesis when min_confidence is below the refusal threshold; the caller
   * should fall back to the raw findings.
   */
  min_confidence: number;
  /**
   * Whether the synthesis pass detected a hallucination risk (e.g. mentions
   * a code or value not in the input findings). Always false for the
   * deterministic provider; populated by LLM-backed providers.
   */
  hallucination_risk: boolean;
}

export interface SynthesisProvider {
  readonly name: string;
  synthesize(req: SynthesisRequest): Promise<SynthesisResult>;
}

export class SynthesisRefusedError extends Error {
  constructor(
    readonly reason: 'low_confidence' | 'no_findings' | 'flag_disabled',
    message: string,
  ) {
    super(message);
    this.name = 'SynthesisRefusedError';
  }
}
