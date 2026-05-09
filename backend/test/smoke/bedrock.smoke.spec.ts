/**
 * Live Bedrock smoke test — gated on `BEDROCK_SMOKE=1` + AWS creds present in
 * the ambient environment (env / SSO / instance role / config file). Skipped
 * by default so CI + local unit runs never call AWS.
 *
 * What it proves:
 *   1. The IAM identity has bedrock:InvokeModel on the configured model.
 *   2. The on-account model ID is reachable (region + access list correct).
 *   3. Our BedrockSdkClient → BedrockSynthesisProvider chain returns a
 *      well-formed SynthesisResult against a real model in <30s.
 *
 * It deliberately uses a TINY synthesis input (one OK finding) so cost is
 * a single-digit-cent invocation, not a load test.
 *
 * Run:
 *   BEDROCK_SMOKE=1 \
 *   AWS_REGION=us-east-1 \
 *   BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0 \
 *   npx jest --config test/smoke/jest-smoke.config.cjs
 */
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { BedrockSdkClient } from '../../src/synthesis/bedrock-sdk-client';
import { BedrockSynthesisProvider } from '../../src/synthesis/bedrock-provider';
import type { SynthesisRequest } from '../../src/synthesis/synthesis-types';

const ENABLED = process.env.BEDROCK_SMOKE === '1';
const smokeDescribe: jest.Describe = ENABLED ? describe : describe.skip;

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'anthropic.claude-3-5-sonnet-20241022-v2:0';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

smokeDescribe('Bedrock live smoke', () => {
  // 30s upper bound — Bedrock p95 for a 600-token completion is ~3–8s, but
  // cold-start of the SDK + network setup can push the first call higher.
  jest.setTimeout(30_000);

  const req: SynthesisRequest = {
    request_id: 'smoke-r1',
    payer_id: 'p',
    state: 'OH',
    product_line: 'medicare_ffs',
    date_of_service: '2026-04-15',
    audience: 'biller',
    findings: [
      {
        severity: 'ok',
        carc_class: 'coverage_50',
        title: 'Code 99497 covered for Medicare FFS in OH on DOS',
        detail: 'ACP code 99497 is covered as a Medicare FFS service in OH for 2026-04-15.',
        confidence: 1,
        citations: [
          {
            source_doc_id: '00000000-0000-0000-0000-000000000001',
            source_url: 'https://www.cms.gov/medicare/medicare-coverage-database',
            retrieved_at: '2026-04-01T00:00:00Z',
            effective_date: '2026-01-01',
            verbatim_quote: '99497 is a Medicare-covered ACP code.',
          },
        ],
      },
    ],
  };

  it('returns a non-refused SynthesisResult from the live model', async () => {
    const runtime = new BedrockRuntimeClient({ region: REGION });
    const adapter = new BedrockSdkClient(runtime);
    const provider = new BedrockSynthesisProvider(adapter, {
      modelId: MODEL_ID,
      systemPrompt:
        'You are a billing-rule explainer. Summarize the findings in 1-3 sentences for a medical biller. Reference codes only by code. Introduce nothing not in findings.',
      maxTokens: 200,
      requireCitationInNarrative: false,
    });

    const result = await provider.synthesize(req);

    expect(result.provider).toBe('bedrock');
    expect(typeof result.narrative).toBe('string');
    expect(result.narrative.length).toBeGreaterThan(20);
    expect(result.severity_summary).toEqual({ critical: 0, warning: 0, info: 0, ok: 1 });
    expect(typeof result.hallucination_risk).toBe('boolean');
  });
});
