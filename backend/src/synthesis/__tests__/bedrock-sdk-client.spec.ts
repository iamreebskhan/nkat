import { BedrockSdkClient } from '../bedrock-sdk-client';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

describe('BedrockSdkClient', () => {
  it('translates invokeModel args into an InvokeModelCommand and unwraps the response body', async () => {
    const captured: { commandInput: unknown }[] = [];
    const responseBody = new TextEncoder().encode(JSON.stringify({ ok: true }));
    const stubRuntime = {
      send: jest.fn(async (cmd: { input?: unknown; constructor: { name: string } }) => {
        captured.push({ commandInput: cmd.input });
        return { body: responseBody };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as BedrockRuntimeClient;

    const adapter = new BedrockSdkClient(stubRuntime);
    const out = await adapter.invokeModel({
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      contentType: 'application/json',
      body: JSON.stringify({ messages: [] }),
    });

    expect(stubRuntime.send).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(200);
    expect(new TextDecoder().decode(out.body)).toBe('{"ok":true}');
    const cmdInput = captured[0].commandInput as {
      modelId: string;
      contentType: string;
      accept: string;
      body: Uint8Array;
    };
    expect(cmdInput.modelId).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(cmdInput.contentType).toBe('application/json');
    expect(cmdInput.accept).toBe('application/json');
    expect(new TextDecoder().decode(cmdInput.body)).toBe('{"messages":[]}');
  });

  it('throws when SDK response has no body', async () => {
    const stubRuntime = {
      send: jest.fn(async () => ({})),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as BedrockRuntimeClient;
    const adapter = new BedrockSdkClient(stubRuntime);
    await expect(
      adapter.invokeModel({
        modelId: 'm',
        contentType: 'application/json',
        body: '{}',
      }),
    ).rejects.toThrow(/no body/);
  });

  it('propagates SDK errors (network, throttle, auth) verbatim', async () => {
    const stubRuntime = {
      send: jest.fn(async () => {
        throw new Error('ThrottlingException: rate exceeded');
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as BedrockRuntimeClient;
    const adapter = new BedrockSdkClient(stubRuntime);
    await expect(
      adapter.invokeModel({ modelId: 'm', contentType: 'application/json', body: '{}' }),
    ).rejects.toThrow(/ThrottlingException/);
  });
});
