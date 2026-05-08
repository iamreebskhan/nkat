/**
 * LookupService — orchestrates the full structured pre-flight against a claim
 * and produces a citation-grounded response.
 *
 * Phase 1 scope: deterministic, non-LLM. Each per-CARC-class check is a
 * single-purpose service. Output is a list of findings keyed by line, plus
 * cross-line findings (bundling, COB, timely-filing).
 */
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CitationDto,
  FindingDto,
  LookupResponseDto,
  LineFindingsDto,
  Severity,
} from '../dto/lookup-response.dto';
import type { LookupRequestDto, ClaimLineDto } from '../dto/lookup-request.dto';
import { ModifierService } from './modifier.service';
import { NcciService } from './ncci.service';
import { TimelyFilingService } from './timely-filing.service';
import { CobService, payerTypeToCoverageType } from './cob.service';
import { MedicalNecessityService } from './icd10-medical-necessity.service';
import { ProviderTaxonomyService } from './provider-taxonomy.service';
import { PayerRuleRepository, type PayerRuleHit } from './payer-rule.repository';
import { SudConsentService, type SudConsentResult } from './sud-consent.service';
import { MhpaeaParityService } from './mhpaea-parity.service';
import { DmepostService } from './dmepos.service';
import { AscService } from '../../asc/asc.service';

const REFUSE_THRESHOLD = 0.5;

function severityRank(s: Severity): number {
  return ({ critical: 3, warning: 2, info: 1, ok: 0 } as const)[s];
}

function maxSeverity(...s: Severity[]): Severity {
  return s.reduce((a, b) => (severityRank(b) > severityRank(a) ? b : a), 'ok');
}

@Injectable()
export class LookupService {
  constructor(
    @Inject(PayerRuleRepository) private readonly rules: PayerRuleRepository,
    @Inject(ModifierService) private readonly modifier: ModifierService,
    @Inject(NcciService) private readonly ncci: NcciService,
    @Inject(TimelyFilingService) private readonly timely: TimelyFilingService,
    @Inject(CobService) private readonly cob: CobService,
    @Inject(MedicalNecessityService) private readonly medNec: MedicalNecessityService,
    @Inject(ProviderTaxonomyService) private readonly tax: ProviderTaxonomyService,
    @Inject(SudConsentService) private readonly sud: SudConsentService,
    @Inject(MhpaeaParityService) private readonly parity: MhpaeaParityService,
    @Inject(DmepostService) private readonly dme: DmepostService,
    @Inject(AscService) private readonly asc: AscService,
  ) {}

  async run(req: LookupRequestDto, orgId: string): Promise<LookupResponseDto> {
    const dos = new Date(`${req.date_of_service}T00:00:00Z`);
    const filing_date = req.filing_date ? new Date(`${req.filing_date}T00:00:00Z`) : new Date();
    const requestId = randomUUID();

    const payerType = (await this.rules.getPayerType(req.payer_id)) ?? 'other';
    const cobCurrentCoverage = payerTypeToCoverageType(payerType) ?? 'commercial';
    const ncciSetting: 'practitioner' | 'outpatient_hospital' | 'dme' = req.product_line.startsWith(
      'institutional',
    )
      ? 'outpatient_hospital'
      : 'practitioner';

    const lineFindings: LineFindingsDto[] = await Promise.all(
      req.lines.map(async (line, idx) => {
        const findings: FindingDto[] = [];

        // (a) Coverage attribute
        findings.push(...(await this.checkCoverage(req, line, dos)));
        // (b) Modifier hierarchy + payer applicability
        findings.push(...(await this.checkModifiers(line, payerType, dos)));
        // (c) Medical necessity (only meaningful when diagnoses provided)
        if (req.diagnoses && req.diagnoses.length > 0) {
          findings.push(...(await this.checkMedicalNecessity(req, line, dos)));
        }
        // (d) Provider taxonomy
        if (req.provider_taxonomy) {
          findings.push(...(await this.checkProviderTaxonomy(req, line, dos)));
        }
        return { line_index: idx, code: line.code, findings };
      }),
    );

    // Cross-line: NCCI bundling + timely filing + COB + SUD consent + MHPAEA parity
    const cross: FindingDto[] = [];
    cross.push(...(await this.checkNcci(req, dos, ncciSetting)));
    cross.push(...(await this.checkTimelyFiling(req, dos, filing_date)));
    if (req.cob_other_coverage) {
      cross.push(...(await this.checkCob(req, dos, cobCurrentCoverage)));
    }
    if (req.client_id) {
      cross.push(...(await this.checkSudConsent(req, dos, orgId)));
    }
    cross.push(...(await this.checkMhpaeaParity(req, dos)));
    cross.push(...(await this.checkDmepos(req, dos)));
    if (req.product_line === 'institutional_asc') {
      cross.push(...(await this.checkAsc(req, dos)));
    }

    const overall = maxSeverity(
      ...lineFindings.flatMap((l) => l.findings.map((f) => f.severity)),
      ...cross.map((f) => f.severity),
      'ok',
    );

    return {
      request_id: requestId,
      date_of_service: req.date_of_service,
      lines: lineFindings,
      cross_line_findings: cross,
      overall_severity: overall,
      summary: this.summarize(overall, lineFindings, cross),
    };
  }

  // ----- per-attribute checks -----

  private async checkCoverage(req: LookupRequestDto, line: ClaimLineDto, dos: Date): Promise<FindingDto[]> {
    const hit = await this.rules.fetchOne({
      payer_id: req.payer_id,
      state: req.state,
      product_line: req.product_line,
      code: line.code,
      attribute: 'covered',
      dos,
    });
    if (!hit) {
      return [
        {
          severity: 'warning',
          carc_class: 'coverage_50',
          title: `No coverage rule on file for ${line.code}`,
          detail: `We have no confirmed (payer, state, product_line, code) coverage rule for ${line.code}. Refusing to assert covered/not-covered.`,
          confidence: 0,
          citations: [],
          recommendation: 'Flag for analyst attestation.',
        },
      ];
    }
    return [coverageFinding(hit, line.code)];
  }

  private async checkModifiers(line: ClaimLineDto, payerType: string, dos: Date): Promise<FindingDto[]> {
    const modifiers = line.modifiers ?? [];
    if (modifiers.length === 0) return [];
    const issues = await this.modifier.validate({
      modifiers,
      payer_type: payerTypeToReadable(payerType),
      dos,
    });
    return issues.map((i) => {
      const isPreferred = i.kind === 'preferred_alternative';
      return {
        severity: isPreferred ? 'info' : 'critical',
        carc_class: 'modifier_4',
        title: i.kind.replace(/_/g, ' '),
        detail: i.message,
        confidence: 1,
        citations: i.source_url
          ? [
              {
                source_doc_id: i.source_url,
                source_url: i.source_url,
                retrieved_at: new Date().toISOString(),
                ...(i.rationale ? { verbatim_quote: i.rationale } : {}),
              },
            ]
          : [],
        ...(isPreferred ? { recommendation: i.message } : {}),
      };
    });
  }

  private async checkNcci(req: LookupRequestDto, dos: Date, setting: 'practitioner' | 'outpatient_hospital' | 'dme'): Promise<FindingDto[]> {
    if (req.lines.length < 2) return [];
    const issues = await this.ncci.evaluate({
      lines: req.lines.map((l, idx) => ({
        index: idx,
        code: l.code,
        modifiers: l.modifiers ?? [],
        units: l.units,
      })),
      setting,
      dos,
    });
    return issues.map((i) => ({
      severity: i.kind === 'ptp_modifier_overrides' ? 'info' : 'critical',
      carc_class: 'bundled_97',
      title: i.kind.replace(/_/g, ' '),
      detail: i.message,
      confidence: 1,
      citations: [
        {
          source_doc_id: i.source_release,
          source_url: 'https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits',
          retrieved_at: new Date().toISOString(),
          verbatim_quote: i.source_release,
        },
      ],
    }));
  }

  private async checkTimelyFiling(req: LookupRequestDto, dos: Date, filing_date: Date): Promise<FindingDto[]> {
    const r = await this.timely.check({
      payer_id: req.payer_id,
      state: req.state,
      product_line: req.product_line,
      dos,
      filing_date,
    });
    if (r.status === 'unknown') return [];
    if (r.status === 'within_window') {
      return [
        {
          severity: 'ok',
          carc_class: 'timely_filing_29',
          title: 'Within timely-filing window',
          detail: `${r.days_remaining} of ${r.window_days} days remain (DOS to today).`,
          confidence: 1,
          citations: r.source_url ? [withCitation(r)] : [],
        },
      ];
    }
    return [
      {
        severity: 'critical',
        carc_class: 'timely_filing_29',
        title: 'Past timely-filing window',
        detail: `${Math.abs(r.days_remaining ?? 0)} days past payer's ${r.window_days}-day window`,
        confidence: 1,
        citations: r.source_url ? [withCitation(r)] : [],
        recommendation: 'Do not file; appeal possible if delay was caused by payer error.',
      },
    ];
  }

  private async checkCob(req: LookupRequestDto, dos: Date, cobCurrentCoverage: string): Promise<FindingDto[]> {
    const r = await this.cob.determine({
      current_payer_type: cobCurrentCoverage,
      other_coverage: req.cob_other_coverage as string,
      dos,
    });
    if (r.status === 'unknown') return [];
    if (r.status === 'current_is_primary') {
      return [
        {
          severity: 'ok',
          carc_class: 'cob_22_24',
          title: 'COB: current payer is primary',
          detail: r.rationale ?? '',
          confidence: 1,
          citations: r.source_url ? [{ source_doc_id: r.rule_id ?? '', source_url: r.source_url, retrieved_at: new Date().toISOString() }] : [],
        },
      ];
    }
    if (r.status === 'current_is_secondary') {
      return [
        {
          severity: 'critical',
          carc_class: 'cob_22_24',
          title: 'COB: current payer is secondary',
          detail: r.rationale ?? `Bill ${r.primary_coverage_type ?? 'other coverage'} first`,
          confidence: 1,
          citations: r.source_url ? [{ source_doc_id: r.rule_id ?? '', source_url: r.source_url, retrieved_at: new Date().toISOString() }] : [],
          recommendation: r.primary_coverage_type ? `Bill ${r.primary_coverage_type} as primary first.` : undefined,
        },
      ];
    }
    return [
      {
        severity: 'warning',
        carc_class: 'cob_22_24',
        title: 'COB: depends on facts',
        detail: r.rationale ?? 'Primary determination depends on conditions that must be verified',
        confidence: 0.7,
        citations: r.source_url ? [{ source_doc_id: r.rule_id ?? '', source_url: r.source_url, retrieved_at: new Date().toISOString() }] : [],
      },
    ];
  }

  private async checkSudConsent(req: LookupRequestDto, dos: Date, orgId: string): Promise<FindingDto[]> {
    const r: SudConsentResult = await this.sud.check({
      org_id: orgId,
      client_id: req.client_id as string,
      patient_external_id: req.patient_external_id ?? null,
      codes: req.lines.map((l) => l.code),
      dos,
    });
    if (r.status === 'no_sud_codes') return [];
    if (r.status === 'consent_active') return [];
    const codes = r.flagged_codes.join(', ');
    if (r.status === 'patient_unknown') {
      return [
        {
          severity: 'critical',
          carc_class: 'part2_consent',
          title: '42 CFR Part 2: SUD code submitted without patient identifier',
          detail: `Codes ${codes} are SUD-Part-2 protected. patient_external_id is required to verify TPO consent.`,
          confidence: 1,
          citations: [{ source_doc_id: '', source_url: 'https://www.ecfr.gov/current/title-42/chapter-I/subchapter-A/part-2', retrieved_at: new Date().toISOString() }],
          recommendation: 'Add patient_external_id and confirm a signed TPO consent is on file before submission.',
        },
      ];
    }
    if (r.status === 'consent_revoked') {
      return [
        {
          severity: 'critical',
          carc_class: 'part2_consent',
          title: '42 CFR Part 2: TPO consent has been revoked',
          detail: `Consent ${r.consent_id} was revoked at ${r.revoked_at?.toISOString() ?? '?'}. Cannot submit SUD codes ${codes}.`,
          confidence: 1,
          citations: [{ source_doc_id: r.consent_id ?? '', source_url: 'https://www.ecfr.gov/current/title-42/chapter-I/subchapter-A/part-2', retrieved_at: new Date().toISOString() }],
          recommendation: 'Obtain a new signed TPO consent (treatment + payment + operations) before re-submission.',
        },
      ];
    }
    return [
      {
        severity: 'critical',
        carc_class: 'part2_consent',
        title: '42 CFR Part 2: no active TPO consent on file',
        detail: `Codes ${codes} are SUD-Part-2 protected. Required scope: ${r.required_scopes.join(', ')}.`,
        confidence: 1,
        citations: [{ source_doc_id: '', source_url: 'https://www.ecfr.gov/current/title-42/chapter-I/subchapter-A/part-2', retrieved_at: new Date().toISOString() }],
        recommendation: 'Obtain a signed TPO consent before submitting these claims.',
      },
    ];
  }

  private async checkAsc(req: LookupRequestDto, dos: Date): Promise<FindingDto[]> {
    const issues = await this.asc.evaluate(
      req.lines.map((l, idx) => ({ index: idx, code: l.code })),
      dos,
    );
    return issues.map((i) => ({
      severity: i.kind === 'asc_not_payable' ? 'critical' : 'warning',
      carc_class: 'asc_payment',
      title: i.kind.replace(/_/g, ' '),
      detail: i.message,
      confidence: 1,
      citations: i.source_url
        ? [
            {
              source_doc_id: '',
              source_url: i.source_url,
              retrieved_at: new Date().toISOString(),
            },
          ]
        : [],
      applies_to_line_index: i.line_index,
    }));
  }

  private async checkDmepos(req: LookupRequestDto, dos: Date): Promise<FindingDto[]> {
    const issues = await this.dme.evaluate(
      req.lines.map((l, idx) => ({
        index: idx,
        code: l.code,
        modifiers: l.modifiers ?? [],
      })),
      dos,
    );
    return issues.map((i) => {
      const severity: Severity =
        i.kind === 'master_list_below_threshold' ? 'info' : 'warning';
      return {
        severity,
        carc_class: 'dmepos_master_list',
        title: i.kind.replace(/_/g, ' '),
        detail: i.message,
        confidence: 1,
        citations: i.source_url
          ? [
              {
                source_doc_id: '',
                source_url: i.source_url,
                retrieved_at: new Date().toISOString(),
              },
            ]
          : [],
        applies_to_line_index: i.line_index,
        ...(i.recommendation ? { recommendation: i.recommendation } : {}),
      };
    });
  }

  private async checkMhpaeaParity(req: LookupRequestDto, dos: Date): Promise<FindingDto[]> {
    const findings: FindingDto[] = [];
    for (const line of req.lines) {
      const r = await this.parity.check({
        payer_id: req.payer_id,
        state: req.state,
        product_line: req.product_line,
        bh_code: line.code,
        dos,
      });
      for (const flag of r.flags) {
        findings.push({
          severity: 'warning',
          carc_class: 'mhpaea',
          title: `MHPAEA parity flag: ${flag.kind.replace(/_/g, ' ')}`,
          detail: flag.detail,
          confidence: flag.confidence,
          citations: [
            {
              source_doc_id: '',
              source_url: 'https://www.dol.gov/agencies/ebsa/laws-and-regulations/laws/mental-health-parity',
              retrieved_at: new Date().toISOString(),
            },
          ],
          recommendation: 'Review with parity counsel; this is a candidate violation, not a confirmed one.',
        });
      }
    }
    return findings;
  }

  private async checkMedicalNecessity(req: LookupRequestDto, line: ClaimLineDto, dos: Date): Promise<FindingDto[]> {
    const r = await this.medNec.check({
      payer_id: req.payer_id,
      state: req.state,
      product_line: req.product_line,
      code: line.code,
      diagnoses: req.diagnoses ?? [],
      dos,
    });
    if (r.status === 'unknown') return [];
    if (r.status === 'covered') {
      return [
        {
          severity: 'ok',
          carc_class: 'medical_necessity_11',
          title: 'Diagnosis supports medical necessity',
          detail: `Matched: ${r.matched_diagnoses.join(', ')}`,
          confidence: 1,
          citations: r.source_url ? [withMedNecCitation(r)] : [],
        },
      ];
    }
    return [
      {
        severity: 'critical',
        carc_class: 'medical_necessity_11',
        title: 'Diagnosis does not support medical necessity',
        detail: `Submitted diagnoses do not match any covered ICD-10 for ${line.code}. Required at least one of: ${r.required_one_of?.slice(0, 12).join(', ')}${(r.required_one_of?.length ?? 0) > 12 ? ', …' : ''}`,
        confidence: 1,
        citations: r.source_url ? [withMedNecCitation(r)] : [],
        recommendation: 'Add a covered diagnosis if clinically supported, or expect CARC 11.',
      },
    ];
  }

  private async checkProviderTaxonomy(req: LookupRequestDto, line: ClaimLineDto, dos: Date): Promise<FindingDto[]> {
    const r = await this.tax.check({
      payer_id: req.payer_id,
      state: req.state,
      product_line: req.product_line,
      code: line.code,
      provider_taxonomy: req.provider_taxonomy as string,
      dos,
    });
    if (r.status === 'unknown') return [];
    if (r.status === 'allowed') {
      return [];
    }
    return [
      {
        severity: 'critical',
        carc_class: 'provider_eligibility_170_185',
        title: 'Provider taxonomy not allowed for this code',
        detail: `Allowed: ${r.allowed_taxonomies.join(', ')}; submitted: ${req.provider_taxonomy}`,
        confidence: 1,
        citations: r.source_url ? [{ source_doc_id: r.rule_id ?? '', source_url: r.source_url, retrieved_at: new Date().toISOString() }] : [],
      },
    ];
  }

  // ----- summary -----
  private summarize(overall: Severity, lines: LineFindingsDto[], cross: FindingDto[]): string {
    const counts = { critical: 0, warning: 0, info: 0, ok: 0 };
    for (const lf of lines) for (const f of lf.findings) counts[f.severity]++;
    for (const f of cross) counts[f.severity]++;
    const parts: string[] = [];
    if (counts.critical) parts.push(`${counts.critical} critical`);
    if (counts.warning) parts.push(`${counts.warning} warning`);
    if (counts.info) parts.push(`${counts.info} info`);
    if (counts.ok) parts.push(`${counts.ok} ok`);
    return `Overall ${overall.toUpperCase()}: ${parts.join(', ')}`;
  }
}

function payerTypeToReadable(payerType: string): string {
  if (payerType.startsWith('medicare')) return 'Medicare';
  if (payerType.startsWith('medicaid')) return 'Medicaid';
  if (payerType === 'workers_comp') return 'Workers Comp';
  if (payerType === 'auto_no_fault') return 'Auto';
  return 'Commercial';
}

function coverageFinding(hit: PayerRuleHit, code: string): FindingDto {
  const refused = hit.confidence < REFUSE_THRESHOLD;
  const citation: CitationDto = {
    source_doc_id: hit.source_doc_id,
    source_url: hit.source_url ?? '',
    retrieved_at: new Date().toISOString(),
    effective_date: hit.effective_date.toISOString().slice(0, 10),
    ...(hit.expiration_date ? { expiration_date: hit.expiration_date.toISOString().slice(0, 10) } : {}),
    ...(hit.source_quote ? { verbatim_quote: hit.source_quote } : {}),
    ...(hit.source_page !== null ? { page_number: hit.source_page } : {}),
  };
  if (refused) {
    return {
      severity: 'warning',
      carc_class: 'coverage_50',
      title: `Low-confidence coverage rule for ${code}`,
      detail: `Confidence ${hit.confidence.toFixed(2)} is below the refuse threshold ${REFUSE_THRESHOLD}.`,
      confidence: hit.confidence,
      citations: [citation],
      recommendation: 'Flag for analyst attestation before submission.',
    };
  }
  if (hit.coverage_status === 'covered') {
    return {
      severity: 'ok',
      carc_class: 'coverage_50',
      title: `${code} is covered`,
      detail: '',
      confidence: hit.confidence,
      citations: [citation],
    };
  }
  if (hit.coverage_status === 'not_covered') {
    return {
      severity: 'critical',
      carc_class: 'coverage_50',
      title: `${code} is not covered`,
      detail: hit.source_quote ?? '',
      confidence: hit.confidence,
      citations: [citation],
      recommendation: 'Consider an ABN if the patient still wants the service (Medicare).',
    };
  }
  return {
    severity: 'warning',
    carc_class: 'coverage_50',
    title: `${code} coverage varies`,
    detail: hit.source_quote ?? 'Coverage depends on conditions that must be verified.',
    confidence: hit.confidence,
    citations: [citation],
  };
}

function withCitation(r: { source_doc_id?: string; source_quote?: string; source_url?: string }): CitationDto {
  return {
    source_doc_id: r.source_doc_id ?? '',
    source_url: r.source_url ?? '',
    retrieved_at: new Date().toISOString(),
    ...(r.source_quote ? { verbatim_quote: r.source_quote } : {}),
  };
}

function withMedNecCitation(r: { rule_id: string | null; source_url: string | null; source_quote: string | null; effective_date: Date | null }): CitationDto {
  return {
    source_doc_id: r.rule_id ?? '',
    source_url: r.source_url ?? '',
    retrieved_at: new Date().toISOString(),
    ...(r.effective_date ? { effective_date: r.effective_date.toISOString().slice(0, 10) } : {}),
    ...(r.source_quote ? { verbatim_quote: r.source_quote } : {}),
  };
}
