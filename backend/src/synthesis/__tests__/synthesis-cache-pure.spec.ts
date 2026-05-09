import { contentHashFor } from '../synthesis-cache-pure';
import type { SynthesisRequest } from '../synthesis-types';

const baseReq: SynthesisRequest = {
  request_id: 'r-1',
  payer_id: 'p',
  state: 'OH',
  product_line: 'medicare_ffs',
  date_of_service: '2026-04-15',
  audience: 'biller',
  findings: [
    {
      severity: 'ok',
      carc_class: 'coverage_50',
      title: 't1',
      detail: 'd1',
      confidence: 1,
      citations: [],
    },
    {
      severity: 'warning',
      carc_class: 'modifier_4',
      title: 't2',
      detail: 'd2',
      confidence: 0.9,
      citations: [],
    },
  ],
};

describe('contentHashFor', () => {
  it('produces a 64-char hex hash', () => {
    expect(contentHashFor('deterministic', baseReq)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic on identical inputs', () => {
    expect(contentHashFor('bedrock', baseReq)).toBe(contentHashFor('bedrock', baseReq));
  });

  it('changes when provider differs', () => {
    expect(contentHashFor('deterministic', baseReq)).not.toBe(contentHashFor('bedrock', baseReq));
  });

  it('changes when audience differs', () => {
    expect(contentHashFor('bedrock', { ...baseReq, audience: 'biller' })).not.toBe(
      contentHashFor('bedrock', { ...baseReq, audience: 'manager' }),
    );
  });

  it('changes when findings differ', () => {
    const r2: SynthesisRequest = {
      ...baseReq,
      findings: [
        ...baseReq.findings,
        {
          severity: 'critical',
          carc_class: 'coverage_50',
          title: 't3',
          detail: 'd3',
          confidence: 1,
          citations: [],
        },
      ],
    };
    expect(contentHashFor('bedrock', baseReq)).not.toBe(contentHashFor('bedrock', r2));
  });

  it('IGNORES request_id, payer_id, state, product_line, date_of_service', () => {
    const r2: SynthesisRequest = {
      ...baseReq,
      request_id: 'r-DIFFERENT',
      payer_id: 'p-DIFFERENT',
      state: 'NC',
      product_line: 'medicaid_mco',
      date_of_service: '2027-01-01',
    };
    expect(contentHashFor('bedrock', baseReq)).toBe(contentHashFor('bedrock', r2));
  });

  it('changes when cacheVersion bumps — global invalidation', () => {
    expect(contentHashFor('bedrock', baseReq, 1)).not.toBe(contentHashFor('bedrock', baseReq, 2));
  });

  it('default cacheVersion is 1 when omitted', () => {
    expect(contentHashFor('bedrock', baseReq)).toBe(contentHashFor('bedrock', baseReq, 1));
  });

  it('is order-stable on findings (sort-keyed canonical)', () => {
    // Object key reordering inside a finding shouldn't change the hash.
    const reorderedFindings = baseReq.findings.map((f) => {
      const { citations, confidence, detail, title, carc_class, severity } = f;
      return { citations, confidence, detail, title, carc_class, severity };
    });
    const r2: SynthesisRequest = { ...baseReq, findings: reorderedFindings };
    expect(contentHashFor('bedrock', baseReq)).toBe(contentHashFor('bedrock', r2));
  });
});
