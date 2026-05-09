import { LookupService } from '../services/lookup.service';
import type { ModifierService } from '../services/modifier.service';
import type { NcciService } from '../services/ncci.service';
import type { TimelyFilingService } from '../services/timely-filing.service';
import type { CobService } from '../services/cob.service';
import type { MedicalNecessityService } from '../services/icd10-medical-necessity.service';
import type { ProviderTaxonomyService } from '../services/provider-taxonomy.service';
import type { PayerRuleRepository, PayerRuleHit } from '../services/payer-rule.repository';
import type { LookupRequestDto } from '../dto/lookup-request.dto';
import type { SudConsentService } from '../services/sud-consent.service';
import type { MhpaeaParityService } from '../services/mhpaea-parity.service';
import type { DmepostService } from '../services/dmepos.service';
import type { AscService } from '../../asc/asc.service';

const PAYER_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_DOC_ID = '22222222-2222-4222-8222-222222222222';

const baseHit = (overrides: Partial<PayerRuleHit> = {}): PayerRuleHit => ({
  rule_id: '33333333-3333-4333-8333-333333333333',
  attribute: 'covered',
  value: { covered: true },
  coverage_status: 'covered',
  confidence: 1,
  effective_date: new Date('2026-01-01'),
  expiration_date: null,
  source_doc_id: SOURCE_DOC_ID,
  source_url: 'https://example/lcd',
  source_quote: 'covered for advance care planning',
  source_page: 4,
  ...overrides,
});

function makeRulesRepo(hit: PayerRuleHit | null, payerType = 'medicare_mac'): PayerRuleRepository {
  return {
    fetchOne: jest.fn().mockResolvedValue(hit),
    getPayerType: jest.fn().mockResolvedValue(payerType),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

interface Services {
  modifier: ModifierService;
  ncci: NcciService;
  timely: TimelyFilingService;
  cob: CobService;
  medNec: MedicalNecessityService;
  tax: ProviderTaxonomyService;
  sud: SudConsentService;
  parity: MhpaeaParityService;
  dme: DmepostService;
  asc: AscService;
}

function makeServices(): Services {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modifier: { validate: jest.fn().mockResolvedValue([]) } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ncci: { evaluate: jest.fn().mockResolvedValue([]) } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    timely: {
      check: jest.fn().mockResolvedValue({
        status: 'unknown',
        window_days: null,
        days_elapsed: 0,
        days_remaining: null,
      }),
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cob: {
      determine: jest
        .fn()
        .mockResolvedValue({ status: 'unknown', rationale: null, source_url: null }),
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    medNec: {
      check: jest.fn().mockResolvedValue({
        status: 'unknown',
        matched_diagnoses: [],
        required_one_of: null,
        rule_id: null,
        source_url: null,
        source_quote: null,
        effective_date: null,
      }),
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tax: {
      check: jest.fn().mockResolvedValue({
        status: 'unknown',
        allowed_taxonomies: [],
        rule_id: null,
        source_url: null,
      }),
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sud: {
      check: jest.fn().mockResolvedValue({
        status: 'no_sud_codes',
        flagged_codes: [],
        required_scopes: ['TPO_payment'],
      }),
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parity: {
      check: jest.fn().mockResolvedValue({ bh_code: '', pairs_checked: [], flags: [] }),
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dme: { evaluate: jest.fn().mockResolvedValue([]) } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    asc: { evaluate: jest.fn().mockResolvedValue([]) } as any,
  };
}

function build(rules: PayerRuleRepository, s: Services): LookupService {
  return new LookupService(
    rules,
    s.modifier,
    s.ncci,
    s.timely,
    s.cob,
    s.medNec,
    s.tax,
    s.sud,
    s.parity,
    s.dme,
    s.asc,
  );
}

const ORG = '11111111-1111-4111-8111-111111111111';

const baseReq: LookupRequestDto = {
  payer_id: PAYER_ID,
  state: 'OH',
  product_line: 'medicare_ffs',
  date_of_service: '2026-04-15',
  lines: [{ code: '99497' }],
};

describe('LookupService.run', () => {
  it('returns ok finding when coverage rule is covered with high confidence', async () => {
    const svc = build(makeRulesRepo(baseHit()), makeServices());
    const r = await svc.run(baseReq, ORG);
    expect(r.lines[0].findings[0]).toMatchObject({ severity: 'ok', carc_class: 'coverage_50' });
    expect(r.lines[0].findings[0].citations[0]).toMatchObject({
      source_doc_id: SOURCE_DOC_ID,
      source_url: 'https://example/lcd',
      verbatim_quote: 'covered for advance care planning',
    });
    expect(r.overall_severity).toBe('ok');
  });

  it('refuses (warning) when coverage rule is below confidence threshold', async () => {
    const svc = build(makeRulesRepo(baseHit({ confidence: 0.4 })), makeServices());
    const r = await svc.run(baseReq, ORG);
    expect(r.lines[0].findings[0]).toMatchObject({
      severity: 'warning',
      title: expect.stringMatching(/Low-confidence/),
    });
    expect(r.lines[0].findings[0].confidence).toBe(0.4);
  });

  it('marks not_covered as critical and includes recommendation about ABN', async () => {
    const svc = build(makeRulesRepo(baseHit({ coverage_status: 'not_covered' })), makeServices());
    const r = await svc.run(baseReq, ORG);
    expect(r.lines[0].findings[0]).toMatchObject({
      severity: 'critical',
      carc_class: 'coverage_50',
    });
    expect(r.lines[0].findings[0].recommendation).toMatch(/ABN/);
    expect(r.overall_severity).toBe('critical');
  });

  it('warns and refuses when no payer_rule exists', async () => {
    const svc = build(makeRulesRepo(null), makeServices());
    const r = await svc.run(baseReq, ORG);
    expect(r.lines[0].findings[0]).toMatchObject({ severity: 'warning', confidence: 0 });
    expect(r.lines[0].findings[0].title).toMatch(/No coverage rule/);
  });

  it('skips medical necessity check when no diagnoses are supplied', async () => {
    const services = makeServices();
    const svc = build(makeRulesRepo(baseHit()), services);
    await svc.run(baseReq, ORG);
    expect(services.medNec.check).not.toHaveBeenCalled();
  });

  it('runs medical necessity check when diagnoses are supplied', async () => {
    const services = makeServices();
    (services.medNec.check as jest.Mock).mockResolvedValueOnce({
      status: 'covered',
      matched_diagnoses: ['Z51.5'],
      required_one_of: ['Z51.5', 'C18.0'],
      rule_id: 'ruleX',
      source_url: 'https://example/lcd-icd',
      source_quote: 'covered when patient has terminal illness',
      effective_date: new Date('2026-01-01'),
    });
    const svc = build(makeRulesRepo(baseHit()), services);
    const r = await svc.run({ ...baseReq, diagnoses: ['Z51.5'] }, ORG);
    expect(services.medNec.check).toHaveBeenCalledTimes(1);
    expect(
      r.lines[0].findings.some(
        (f) => f.carc_class === 'medical_necessity_11' && f.severity === 'ok',
      ),
    ).toBe(true);
  });

  it('promotes overall_severity to critical when timely-filing fails', async () => {
    const services = makeServices();
    (services.timely.check as jest.Mock).mockResolvedValueOnce({
      status: 'past_window',
      window_days: 90,
      days_elapsed: 200,
      days_remaining: -110,
      source_doc_id: 'doc1',
      source_quote: 'Humana 90 days from DOS',
      source_url: 'https://humana/timely',
    });
    const svc = build(makeRulesRepo(baseHit()), services);
    const r = await svc.run(baseReq, ORG);
    expect(
      r.cross_line_findings.some(
        (f) => f.carc_class === 'timely_filing_29' && f.severity === 'critical',
      ),
    ).toBe(true);
    expect(r.overall_severity).toBe('critical');
  });

  it('skips NCCI when only one line is on the claim', async () => {
    const services = makeServices();
    const svc = build(makeRulesRepo(baseHit()), services);
    await svc.run(baseReq, ORG);
    expect(services.ncci.evaluate).not.toHaveBeenCalled();
  });

  it('runs NCCI when 2+ lines are on the claim', async () => {
    const services = makeServices();
    const svc = build(makeRulesRepo(baseHit()), services);
    await svc.run({ ...baseReq, lines: [{ code: '99213' }, { code: '36415' }] }, ORG);
    expect(services.ncci.evaluate).toHaveBeenCalledTimes(1);
  });

  it('emits a request_id (UUID) on every response', async () => {
    const svc = build(makeRulesRepo(baseHit()), makeServices());
    const r1 = await svc.run(baseReq, ORG);
    const r2 = await svc.run(baseReq, ORG);
    expect(r1.request_id).not.toEqual(r2.request_id);
    expect(r1.request_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('skips SUD consent check when client_id is not provided', async () => {
    const services = makeServices();
    const svc = build(makeRulesRepo(baseHit()), services);
    await svc.run(baseReq, ORG);
    expect(services.sud.check).not.toHaveBeenCalled();
  });

  it('runs SUD consent check when client_id is provided', async () => {
    const services = makeServices();
    const svc = build(makeRulesRepo(baseHit()), services);
    await svc.run({ ...baseReq, client_id: '22222222-2222-4222-8222-222222222222' }, ORG);
    expect(services.sud.check).toHaveBeenCalledTimes(1);
  });

  it('emits CRITICAL part2_consent finding when consent_missing', async () => {
    const services = makeServices();
    (services.sud.check as jest.Mock).mockResolvedValueOnce({
      status: 'consent_missing',
      flagged_codes: ['H0004'],
      required_scopes: ['TPO_payment'],
    });
    const svc = build(makeRulesRepo(baseHit()), services);
    const r = await svc.run(
      {
        ...baseReq,
        client_id: '22222222-2222-4222-8222-222222222222',
        patient_external_id: 'PHASH1',
      },
      ORG,
    );
    const consent = r.cross_line_findings.find((f) => f.carc_class === 'part2_consent');
    expect(consent).toBeDefined();
    expect(consent!.severity).toBe('critical');
    expect(consent!.detail).toContain('H0004');
    expect(r.overall_severity).toBe('critical');
  });

  it('emits CRITICAL part2_consent when consent_revoked', async () => {
    const services = makeServices();
    (services.sud.check as jest.Mock).mockResolvedValueOnce({
      status: 'consent_revoked',
      flagged_codes: ['H0010'],
      consent_id: 'cons-1',
      revoked_at: new Date('2026-04-01'),
      required_scopes: ['TPO_payment'],
    });
    const svc = build(makeRulesRepo(baseHit()), services);
    const r = await svc.run({ ...baseReq, client_id: '22222222-2222-4222-8222-222222222222' }, ORG);
    const consent = r.cross_line_findings.find((f) => f.carc_class === 'part2_consent');
    expect(consent!.severity).toBe('critical');
    expect(consent!.detail).toContain('revoked');
  });

  it('does not emit part2_consent when status is consent_active', async () => {
    const services = makeServices();
    (services.sud.check as jest.Mock).mockResolvedValueOnce({
      status: 'consent_active',
      flagged_codes: ['H0004'],
      consent_id: 'c1',
      required_scopes: ['TPO_payment'],
    });
    const svc = build(makeRulesRepo(baseHit()), services);
    const r = await svc.run({ ...baseReq, client_id: '22222222-2222-4222-8222-222222222222' }, ORG);
    expect(r.cross_line_findings.find((f) => f.carc_class === 'part2_consent')).toBeUndefined();
  });

  it('emits dmepos_master_list finding when DmepostService returns issues', async () => {
    const services = makeServices();
    (services.dme.evaluate as jest.Mock).mockResolvedValueOnce([
      {
        kind: 'master_list_pa_required',
        line_index: 0,
        code: 'E0470',
        message: 'E0470 requires PA',
        source_url: 'https://example/master-list',
        recommendation: 'Confirm a PA approval is on file.',
      },
    ]);
    const svc = build(makeRulesRepo(baseHit()), services);
    const r = await svc.run({ ...baseReq, lines: [{ code: 'E0470' }] }, ORG);
    const dme = r.cross_line_findings.find((f) => f.carc_class === 'dmepos_master_list');
    expect(dme).toBeDefined();
    expect(dme!.severity).toBe('warning');
    expect(dme!.applies_to_line_index).toBe(0);
    expect(dme!.recommendation).toMatch(/PA/);
  });

  it('demotes DMEPOS below_threshold to info severity', async () => {
    const services = makeServices();
    (services.dme.evaluate as jest.Mock).mockResolvedValueOnce([
      {
        kind: 'master_list_below_threshold',
        line_index: 0,
        code: 'E0470',
        message: 'below threshold',
        source_url: null,
      },
    ]);
    const svc = build(makeRulesRepo(baseHit()), services);
    const r = await svc.run({ ...baseReq, lines: [{ code: 'E0470' }] }, ORG);
    const dme = r.cross_line_findings.find((f) => f.carc_class === 'dmepos_master_list')!;
    expect(dme.severity).toBe('info');
  });

  it('skips ASC check when product_line is not institutional_asc', async () => {
    const services = makeServices();
    const svc = build(makeRulesRepo(baseHit()), services);
    await svc.run({ ...baseReq, product_line: 'medicare_ffs' }, ORG);
    expect(services.asc.evaluate).not.toHaveBeenCalled();
  });

  it('runs ASC check when product_line is institutional_asc', async () => {
    const services = makeServices();
    (services.asc.evaluate as jest.Mock).mockResolvedValueOnce([
      {
        kind: 'asc_not_payable',
        line_index: 0,
        code: '99213',
        message: '99213 is not on the CMS ASC fee schedule.',
      },
    ]);
    const svc = build(makeRulesRepo(baseHit()), services);
    const r = await svc.run(
      { ...baseReq, product_line: 'institutional_asc', lines: [{ code: '99213' }] },
      ORG,
    );
    expect(services.asc.evaluate).toHaveBeenCalledTimes(1);
    const ascFinding = r.cross_line_findings.find((f) => f.carc_class === 'asc_payment');
    expect(ascFinding).toBeDefined();
    expect(ascFinding!.severity).toBe('critical');
  });

  it('demotes asc_office_based to warning severity', async () => {
    const services = makeServices();
    (services.asc.evaluate as jest.Mock).mockResolvedValueOnce([
      {
        kind: 'asc_office_based',
        line_index: 0,
        code: '11042',
        message: 'A2 — office-based',
        source_url: 'https://cms/asc',
      },
    ]);
    const svc = build(makeRulesRepo(baseHit()), services);
    const r = await svc.run(
      { ...baseReq, product_line: 'institutional_asc', lines: [{ code: '11042' }] },
      ORG,
    );
    const ascFinding = r.cross_line_findings.find((f) => f.carc_class === 'asc_payment');
    expect(ascFinding!.severity).toBe('warning');
  });

  it('runs MHPAEA parity check for every line and surfaces flags as warnings', async () => {
    const services = makeServices();
    (services.parity.check as jest.Mock).mockResolvedValueOnce({
      bh_code: '99497',
      pairs_checked: [{ med_surg_code: '99203', classification: 'outpatient_in_network' }],
      flags: [
        {
          kind: 'prior_auth_more_restrictive',
          bh_code: '99497',
          med_surg_code: '99203',
          detail: 'BH requires PA, med/surg does not',
          confidence: 1,
        },
      ],
    });
    const svc = build(makeRulesRepo(baseHit()), services);
    const r = await svc.run(baseReq, ORG);
    const parity = r.cross_line_findings.find((f) => f.carc_class === 'mhpaea');
    expect(parity).toBeDefined();
    expect(parity!.severity).toBe('warning');
    expect(parity!.recommendation).toMatch(/parity counsel/);
  });
});
