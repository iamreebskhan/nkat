/**
 * DeterministicSynthesisProvider.
 *
 * Produces a plain-English summary of structured findings WITHOUT calling an
 * LLM. Lets us ship the synthesis API surface today and swap to Bedrock once
 * the AMA license + AWS BAA are signed without changing any callers.
 *
 * The provider is deliberately boring: it groups findings by severity,
 * stitches sentence templates per CARC class, and concatenates citations.
 * Hallucination risk is structurally zero because the function is pure.
 */
import { Injectable } from '@nestjs/common';
import type { CitationDto, FindingDto, Severity } from '../lookup/dto/lookup-response.dto';
import {
  SynthesisRefusedError,
  type SynthesisProvider,
  type SynthesisRequest,
  type SynthesisResult,
} from './synthesis-types';

const REFUSAL_THRESHOLD = 0.5;

const SEVERITY_LEAD: Record<Severity, string> = {
  critical: 'Block before submission',
  warning: 'Review before submission',
  info: 'For your awareness',
  ok: 'Verified clean',
};

const CARC_LABEL: Record<string, string> = {
  medical_necessity_11: 'medical-necessity (CARC 11)',
  missing_info_16: 'missing/invalid info (CARC 16)',
  bundled_97: 'bundling (CARC 97)',
  modifier_4: 'modifier (CARC 4)',
  coverage_50: 'coverage (CO-50)',
  timely_filing_29: 'timely filing (CARC 29)',
  cob_22_24: 'coordination of benefits (CARC 22/24)',
  provider_eligibility_170_185: 'provider eligibility (CARC 170/185)',
  mhpaea: 'MHPAEA parity',
  part2_consent: '42 CFR Part 2 SUD consent',
  abn_required: 'ABN required',
  dmepos_master_list: 'DMEPOS Master List',
  unknown: 'unspecified',
};

function severityRank(s: Severity): number {
  return ({ critical: 3, warning: 2, info: 1, ok: 0 } as const)[s];
}

function bulletForFinding(f: FindingDto): string {
  const cl = CARC_LABEL[f.carc_class] ?? f.carc_class;
  const head = `[${f.severity.toUpperCase()}] ${cl} — ${f.title}`;
  const tail = f.detail ? `: ${f.detail.replace(/\s+/g, ' ').trim()}` : '';
  const reco = f.recommendation ? ` Recommendation: ${f.recommendation}` : '';
  return `${head}${tail}${reco}`;
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

@Injectable()
export class DeterministicSynthesisProvider implements SynthesisProvider {
  readonly name = 'deterministic';

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    if (req.findings.length === 0) {
      throw new SynthesisRefusedError('no_findings', 'No findings to synthesize.');
    }

    const minConfidence = req.findings.reduce((m, f) => Math.min(m, f.confidence ?? 1), 1);
    if (minConfidence < REFUSAL_THRESHOLD) {
      throw new SynthesisRefusedError(
        'low_confidence',
        `Lowest finding confidence ${minConfidence.toFixed(2)} < refusal threshold ${REFUSAL_THRESHOLD}`,
      );
    }

    const sortedFindings = [...req.findings].sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity),
    );
    const overall: Severity = sortedFindings[0]?.severity ?? 'ok';

    const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0, ok: 0 };
    for (const f of sortedFindings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

    const citations = dedupeCitations(sortedFindings.flatMap((f) => f.citations ?? []));

    const lead = `${SEVERITY_LEAD[overall]} for claim on ${req.date_of_service}.`;
    const counts_line = `${counts.critical} critical, ${counts.warning} warning, ${counts.info} info, ${counts.ok} ok findings.`;
    const bullets = sortedFindings
      .map(bulletForFinding)
      .map((b) => `  • ${b}`)
      .join('\n');
    const audienceFooter = audienceFooterFor(req.audience);

    const narrative = [lead, counts_line, '', bullets, '', audienceFooter].join('\n');

    return {
      narrative,
      citations,
      severity_summary: counts,
      provider: this.name,
      min_confidence: minConfidence,
      hallucination_risk: false,
    };
  }
}

function audienceFooterFor(audience: SynthesisRequest['audience']): string {
  switch (audience) {
    case 'biller':
      return 'Resolve every CRITICAL before submitting. WARNING items may still be billable but raise denial risk.';
    case 'manager':
      return 'Trends across recent claims appear in the denial dashboard; this single-claim view is for spot-checking.';
    case 'analyst':
      return 'Citation panel above is end-to-end preserved from authoritative sources. Each finding has a confidence score.';
  }
}

/** Visible for tests of the formatter helpers. */
export const _testing = { bulletForFinding, dedupeCitations, severityRank };
