/**
 * BedrockSdkClient — concrete adapter wrapping @aws-sdk/client-bedrock-runtime.
 *
 * Conforms to the abstract `BedrockClient` interface declared by the
 * BedrockSynthesisProvider, so Phase 6 unit tests still stub the network
 * without ever touching AWS. Production wiring uses this adapter.
 *
 * The adapter is deliberately thin: input/output translation only. We do NOT
 * choose region, credentials, or retry strategy here — those are
 * configuration concerns of the surrounding `BedrockRuntimeClient` instance.
 */
import type { BedrockClient } from './bedrock-provider';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
  type InvokeModelCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';

export class BedrockSdkClient implements BedrockClient {
  constructor(private readonly client: BedrockRuntimeClient) {}

  async invokeModel(args: {
    modelId: string;
    contentType: 'application/json';
    body: string;
  }): Promise<{ body: Uint8Array; status: number }> {
    const input: InvokeModelCommandInput = {
      modelId: args.modelId,
      contentType: args.contentType,
      accept: 'application/json',
      body: new TextEncoder().encode(args.body),
    };
    const cmd = new InvokeModelCommand(input);
    const out: InvokeModelCommandOutput = await this.client.send(cmd);

    // The SDK does not surface the HTTP status as a number on the modelled
    // response shape — a successful resolve is 2xx, an exception means
    // non-2xx. We adopt a simple convention: resolved → 200, throws are
    // bubbled up.
    if (!out.body) {
      throw new Error('Bedrock response had no body');
    }
    // out.body is a Uint8Array per the SDK type.
    return { body: out.body as Uint8Array, status: 200 };
  }
}

/**
 * Convenience factory: build the SDK client + our adapter from a region
 * string. Pass nothing in tests; pass `{ region: ... }` in production.
 */
export function createBedrockSdkClient(opts: { region?: string } = {}): BedrockSdkClient {
  const runtime = opts.region
    ? new BedrockRuntimeClient({ region: opts.region })
    : new BedrockRuntimeClient({});
  return new BedrockSdkClient(runtime);
}
