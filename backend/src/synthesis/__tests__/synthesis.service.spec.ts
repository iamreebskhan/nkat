import { SynthesisService } from '../synthesis.service';
import { SynthesisRefusedError, type SynthesisProvider, type SynthesisRequest } from '../synthesis-types';
import type { FeatureFlagService } from '../../feature-flags/feature-flag.service';
import type { DeterministicSynthesisProvider } from '../deterministic-provider';
import type { BedrockSynthesisProvider } from '../bedrock-provider';

const ORG = '11111111-1111-4111-8111-111111111111';

function makeFlags(args: { enabled: boolean; providerName?: string }): FeatureFlagService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    isEnabled: jest.fn().mockResolvedValue(args.enabled),
    getConfig: jest.fn().mockResolvedValue(args.providerName ? { name: args.providerName } : {}),
    resolve: jest.fn(),
    setFlag: jest.fn(),
  } as any;
}

const detProvider: DeterministicSynthesisProvider = {
  name: 'deterministic',
  synthesize: jest.fn().mockResolvedValue({
    narrative: 'det out',
    citations: [],
    severity_summary: { critical: 0, warning: 0, info: 0, ok: 1 },
    provider: 'deterministic',
    min_confidence: 1,
    hallucination_risk: false,
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const bedrockProvider: BedrockSynthesisProvider = {
  name: 'bedrock',
  synthesize: jest.fn().mockResolvedValue({
    narrative: 'bedrock out',
    citations: [],
    severity_summary: { critical: 0, warning: 0, info: 0, ok: 1 },
    provider: 'bedrock',
    min_confidence: 1,
    hallucination_risk: false,
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const baseReq: SynthesisRequest = {
  request_id: 'r1',
  payer_id: 'p',
  state: 'OH',
  product_line: 'medicare_ffs',
  date_of_service: '2026-04-15',
  findings: [
    {
      severity: 'ok',
      carc_class: 'coverage_50',
      title: 't',
      detail: 'd',
      confidence: 1,
      citations: [],
    },
  ],
  audience: 'biller',
};

describe('SynthesisService', () => {
  it('refuses when synthesis.enabled = false', async () => {
    const svc = new SynthesisService(makeFlags({ enabled: false }), detProvider, bedrockProvider);
    await expect(svc.synthesize(ORG, baseReq)).rejects.toMatchObject({
      reason: 'flag_disabled',
    });
    await expect(svc.synthesize(ORG, baseReq)).rejects.toBeInstanceOf(SynthesisRefusedError);
  });

  it('picks deterministic provider by default', async () => {
    const svc = new SynthesisService(makeFlags({ enabled: true }), detProvider, bedrockProvider);
    const r = await svc.synthesize(ORG, baseReq);
    expect(r.provider).toBe('deterministic');
  });

  it('picks Bedrock provider when flag config sets name=bedrock', async () => {
    const svc = new SynthesisService(
      makeFlags({ enabled: true, providerName: 'bedrock' }),
      detProvider,
      bedrockProvider,
    );
    const r = await svc.synthesize(ORG, baseReq);
    expect(r.provider).toBe('bedrock');
  });

  it('falls back to deterministic when bedrock provider is not registered', async () => {
    const svc = new SynthesisService(
      makeFlags({ enabled: true, providerName: 'bedrock' }),
      detProvider,
      undefined as unknown as BedrockSynthesisProvider,
    );
    const r = await svc.synthesize(ORG, baseReq);
    expect(r.provider).toBe('deterministic');
  });

  it('pickProvider returns provider for assertion in tests', async () => {
    const svc = new SynthesisService(makeFlags({ enabled: true }), detProvider, bedrockProvider);
    const p: SynthesisProvider = await svc.pickProvider(ORG);
    expect(p.name).toBe('deterministic');
  });

  it('uppercase / mixed-case provider name works (case-insensitive lookup)', async () => {
    const svc = new SynthesisService(
      makeFlags({ enabled: true, providerName: 'Bedrock' }),
      detProvider,
      bedrockProvider,
    );
    expect((await svc.pickProvider(ORG)).name).toBe('bedrock');
  });
});
