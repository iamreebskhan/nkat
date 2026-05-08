import {
  BedrockSynthesisProvider,
  buildUserMessage,
  collectAllowedTokens,
  detectHallucinations,
  type BedrockClient,
} from '../bedrock-provider';
import { SynthesisRefusedError, type SynthesisRequest } from '../synthesis-types';
import type { FindingDto } from '../../lookup/dto/lookup-response.dto';

const makeFinding = (over: Partial<FindingDto> = {}): FindingDto => ({
  severity: 'warning',
  carc_class: 'bundled_97',
  title: 'NCCI bundling',
  detail: '99213 + 36415 are bundled per NCCI v32.0',
  confidence: 1,
  citations: [
    {
      source_doc_id: '11111111-1111-4111-8111-111111111111',
      source_url: 'https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits',
      retrieved_at: '2026-04-15T00:00:00Z',
      verbatim_quote: 'Column 1 99213, Column 2 36415',
    },
  ],
  recommendation: 'Drop 36415 or add an X-modifier (XU/XE) when documentation supports a distinct service.',
  ...over,
});

const baseReq = (over: Partial<SynthesisRequest> = {}): SynthesisRequest => ({
  request_id: 'r1',
  payer_id: '22222222-2222-4222-8222-222222222222',
  state: 'OH',
  product_line: 'medicare_ffs',
  date_of_service: '2026-04-15',
  audience: 'biller',
  findings: [makeFinding()],
  ...over,
});

const okClient = (text: string): BedrockClient => ({
  async invokeModel(_args) {
    const body = new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text }] }));
    return { body, status: 200 };
  },
});

describe('BedrockSynthesisProvider', () => {
  it('refuses on empty findings', async () => {
    const p = new BedrockSynthesisProvider(okClient('ignored'));
    await expect(p.synthesize(baseReq({ findings: [] }))).rejects.toBeInstanceOf(SynthesisRefusedError);
  });

  it('refuses when min confidence < 0.5', async () => {
    const p = new BedrockSynthesisProvider(okClient('ignored'));
    await expect(
      p.synthesize(baseReq({ findings: [makeFinding({ confidence: 0.3 })] })),
    ).rejects.toMatchObject({ reason: 'low_confidence' });
  });

  it('returns narrative on a 200 response with valid Anthropic-shaped body', async () => {
    const text =
      'Block before submission. NCCI v32.0 bundles 99213 with 36415; either drop the lab line or add an X-modifier. ' +
      'See https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits for the edit detail.';
    const p = new BedrockSynthesisProvider(okClient(text));
    const r = await p.synthesize(baseReq());
    expect(r.provider).toBe('bedrock');
    expect(r.narrative).toBe(text);
    expect(r.hallucination_risk).toBe(false);
    expect(r.citations).toHaveLength(1);
  });

  it('flags hallucination_risk when narrative mentions an unseen code', async () => {
    const text = 'NCCI bundles 99213 with 36415 and you should also consider J9035.'; // J9035 not in findings
    const p = new BedrockSynthesisProvider(okClient(text));
    const r = await p.synthesize(baseReq());
    expect(r.hallucination_risk).toBe(true);
  });

  it('flags hallucination_risk when narrative mentions an unseen URL', async () => {
    const text = 'See https://example.com/fake-source for details.';
    const p = new BedrockSynthesisProvider(okClient(text));
    const r = await p.synthesize(baseReq());
    expect(r.hallucination_risk).toBe(true);
  });

  it('flags hallucination_risk when narrative mentions an unseen source_doc_id', async () => {
    const text = 'See document 99999999-9999-4999-8999-999999999999 for the rule.';
    const p = new BedrockSynthesisProvider(okClient(text));
    const r = await p.synthesize(baseReq());
    expect(r.hallucination_risk).toBe(true);
  });

  it('throws on non-2xx Bedrock response', async () => {
    const failingClient: BedrockClient = {
      async invokeModel() {
        return { body: new TextEncoder().encode(''), status: 500 };
      },
    };
    const p = new BedrockSynthesisProvider(failingClient);
    await expect(p.synthesize(baseReq())).rejects.toThrow(/HTTP 500/);
  });

  it('refuses when Bedrock returns an empty narrative', async () => {
    const emptyClient: BedrockClient = {
      async invokeModel() {
        const body = new TextEncoder().encode(JSON.stringify({ content: [] }));
        return { body, status: 200 };
      },
    };
    const p = new BedrockSynthesisProvider(emptyClient);
    await expect(p.synthesize(baseReq())).rejects.toBeInstanceOf(SynthesisRefusedError);
  });
});

describe('buildUserMessage', () => {
  it('serializes findings deterministically', () => {
    const msg = buildUserMessage(baseReq());
    expect(msg).toMatch(/Payer: /);
    expect(msg).toMatch(/Date of service: 2026-04-15/);
    expect(msg).toMatch(/Audience: biller/);
    expect(msg).toMatch(/1\. \[WARNING\] bundled_97/);
    expect(msg).toMatch(/Rec: /);
  });
});

describe('collectAllowedTokens', () => {
  it('extracts codes / urls / doc-ids from findings', () => {
    const t = collectAllowedTokens([makeFinding()]);
    expect(t.codes.has('99213')).toBe(true);
    expect(t.codes.has('36415')).toBe(true);
    expect(t.urls.has('https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits')).toBe(true);
    expect(t.source_doc_ids.has('11111111-1111-4111-8111-111111111111')).toBe(true);
  });
});

describe('detectHallucinations', () => {
  const allowed = {
    codes: new Set(['99213', '36415']),
    urls: new Set(['https://example/legit']),
    source_doc_ids: new Set(['11111111-1111-4111-8111-111111111111']),
  };

  it('returns false when narrative only mentions allowed tokens', () => {
    expect(detectHallucinations('99213 with 36415 — see https://example/legit.', allowed)).toBe(false);
  });

  it('returns true on unseen code', () => {
    expect(detectHallucinations('99213 with J9035', allowed)).toBe(true);
  });

  it('returns true on unseen url', () => {
    expect(detectHallucinations('see https://other.example', allowed)).toBe(true);
  });

  it('returns true on unseen doc id', () => {
    expect(detectHallucinations('doc 99999999-9999-4999-8999-999999999999', allowed)).toBe(true);
  });
});
