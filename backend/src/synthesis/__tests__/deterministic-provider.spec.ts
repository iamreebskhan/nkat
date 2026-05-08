import { DeterministicSynthesisProvider, _testing } from '../deterministic-provider';
import { SynthesisRefusedError, type SynthesisRequest } from '../synthesis-types';
import type { FindingDto } from '../../lookup/dto/lookup-response.dto';

const finding = (over: Partial<FindingDto> = {}): FindingDto => ({
  severity: 'ok',
  carc_class: 'coverage_50',
  title: 'Covered',
  detail: '',
  confidence: 1,
  citations: [
    { source_doc_id: 'doc-1', source_url: 'https://example/lcd', retrieved_at: '2026-04-15T00:00:00Z' },
  ],
  ...over,
});

const baseReq = (over: Partial<SynthesisRequest> = {}): SynthesisRequest => ({
  request_id: 'req-1',
  payer_id: '11111111-1111-4111-8111-111111111111',
  state: 'OH',
  product_line: 'medicare_ffs',
  date_of_service: '2026-04-15',
  findings: [finding()],
  audience: 'biller',
  ...over,
});

describe('DeterministicSynthesisProvider', () => {
  const provider = new DeterministicSynthesisProvider();

  it('refuses when there are no findings', async () => {
    await expect(provider.synthesize(baseReq({ findings: [] }))).rejects.toThrow(SynthesisRefusedError);
  });

  it('refuses when any finding is below the 0.5 confidence threshold', async () => {
    const req = baseReq({ findings: [finding({ confidence: 0.4 })] });
    await expect(provider.synthesize(req)).rejects.toMatchObject({
      reason: 'low_confidence',
    });
  });

  it('produces narrative with critical lead when any finding is critical', async () => {
    const r = await provider.synthesize(
      baseReq({ findings: [finding({ severity: 'ok' }), finding({ severity: 'critical', title: 'CARC 97' })] }),
    );
    expect(r.narrative).toMatch(/Block before submission/);
    expect(r.severity_summary).toEqual({ critical: 1, warning: 0, info: 0, ok: 1 });
    expect(r.provider).toBe('deterministic');
    expect(r.hallucination_risk).toBe(false);
  });

  it('preserves and dedupes citations end-to-end', async () => {
    const r = await provider.synthesize(
      baseReq({
        findings: [
          finding({ citations: [{ source_doc_id: 'd1', source_url: 'https://a', retrieved_at: 'x' }] }),
          finding({ citations: [{ source_doc_id: 'd1', source_url: 'https://a', retrieved_at: 'x' }] }), // duplicate
          finding({ citations: [{ source_doc_id: 'd2', source_url: 'https://b', retrieved_at: 'y' }] }),
        ],
      }),
    );
    expect(r.citations.map((c) => c.source_doc_id)).toEqual(['d1', 'd2']);
  });

  it('orders findings critical → warning → info → ok in the bullet list', async () => {
    const r = await provider.synthesize(
      baseReq({
        findings: [
          finding({ severity: 'info',     title: 'A' }),
          finding({ severity: 'critical', title: 'B' }),
          finding({ severity: 'ok',       title: 'C' }),
          finding({ severity: 'warning',  title: 'D' }),
        ],
      }),
    );
    const lines = r.narrative.split('\n').filter((l) => l.trim().startsWith('•'));
    const titles = lines.map((l) => /[A-D]\b/.exec(l)?.[0]).filter(Boolean);
    expect(titles).toEqual(['B', 'D', 'A', 'C']);
  });

  it('reports min_confidence as the lowest finding confidence', async () => {
    const r = await provider.synthesize(
      baseReq({ findings: [finding({ confidence: 1 }), finding({ confidence: 0.7 })] }),
    );
    expect(r.min_confidence).toBeCloseTo(0.7, 5);
  });

  it('renders different audience footers', async () => {
    const biller = await provider.synthesize(baseReq({ audience: 'biller' }));
    const manager = await provider.synthesize(baseReq({ audience: 'manager' }));
    const analyst = await provider.synthesize(baseReq({ audience: 'analyst' }));
    expect(biller.narrative).toMatch(/Resolve every CRITICAL/);
    expect(manager.narrative).toMatch(/denial dashboard/);
    expect(analyst.narrative).toMatch(/Citation panel/);
  });

  it('hallucination_risk is always false for the deterministic provider', async () => {
    const r = await provider.synthesize(baseReq());
    expect(r.hallucination_risk).toBe(false);
  });

  it('bulletForFinding includes severity, CARC label, title, detail, and recommendation', () => {
    const text = _testing.bulletForFinding({
      severity: 'critical',
      carc_class: 'bundled_97',
      title: 'PTP edit',
      detail: '99213 + 36415 are bundled',
      confidence: 1,
      citations: [],
      recommendation: 'Drop 36415 or add an X-modifier',
    });
    expect(text).toMatch(/CRITICAL/);
    expect(text).toMatch(/bundling \(CARC 97\)/);
    expect(text).toMatch(/PTP edit/);
    expect(text).toMatch(/99213 \+ 36415 are bundled/);
    expect(text).toMatch(/Recommendation/);
  });

  it('severityRank orders critical highest', () => {
    expect(_testing.severityRank('critical')).toBeGreaterThan(_testing.severityRank('warning'));
    expect(_testing.severityRank('warning')).toBeGreaterThan(_testing.severityRank('info'));
    expect(_testing.severityRank('info')).toBeGreaterThan(_testing.severityRank('ok'));
  });
});
