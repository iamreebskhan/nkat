/**
 * RFC 8058 List-Unsubscribe headers — verifies:
 *
 *   1. EmailService.buildListUnsubscribeHeaders produces the two
 *      headers Gmail / Apple Mail / Outlook expect for one-click
 *      unsubscribe rendering.
 *   2. SesV2EmailClient serializes headers into the Content.Simple.Headers
 *      JSON field SES expects.
 *   3. URL is wrapped in <angle brackets>; URL with `,` doesn't
 *      need additional escaping (the brackets are the delimiter).
 */
import { buildListUnsubscribeHeaders } from '../email.service';
import { SesV2EmailClient } from '../ses-v2-email-client';

describe('buildListUnsubscribeHeaders', () => {
  it('produces both headers in the documented shape', () => {
    const headers = buildListUnsubscribeHeaders('https://app.example.com/v1/u/abc.def');
    expect(headers).toEqual([
      { name: 'List-Unsubscribe', value: '<https://app.example.com/v1/u/abc.def>' },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    ]);
  });

  it('preserves the full token (including the dot separator) inside the angle brackets', () => {
    const headers = buildListUnsubscribeHeaders(
      'https://app.example.com/v1/u/eyJlbWFpbCI6ImFAeC5jb20iLCJzY29wZSI6Im1hbnVhbF9vcHRvdXQiLCJleHAiOjE3MDB9.SIGNATURE_PART',
    );
    expect(headers[0].value).toMatch(/^<https:\/\/app\.example\.com\/v1\/u\/[A-Za-z0-9._~-]+>$/);
  });
});

describe('SesV2EmailClient serializes headers into Content.Simple.Headers', () => {
  function fakeFetchOk(body: unknown): typeof globalThis.fetch {
    return jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response) as unknown as typeof globalThis.fetch;
  }

  it('omits Headers when none supplied', async () => {
    const fetchImpl = fakeFetchOk({ MessageId: 'm1' });
    const c = new SesV2EmailClient({
      region: 'us-east-1',
      credentialsProvider: () => ({ accessKeyId: 'k', secretAccessKey: 's' }),
      fetchImpl,
    });
    await c.send({
      to: 'a@x',
      from: 'no-reply@x',
      subject: 's',
      html: 'h',
      text: 't',
    });
    const init = (fetchImpl as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const simple = (body.Content as { Simple: Record<string, unknown> }).Simple;
    expect(simple.Headers).toBeUndefined();
  });

  it('includes Headers when supplied — capitalized Name/Value per AWS shape', async () => {
    const fetchImpl = fakeFetchOk({ MessageId: 'm2' });
    const c = new SesV2EmailClient({
      region: 'us-east-1',
      credentialsProvider: () => ({ accessKeyId: 'k', secretAccessKey: 's' }),
      fetchImpl,
    });
    await c.send({
      to: 'a@x',
      from: 'no-reply@x',
      subject: 's',
      html: 'h',
      text: 't',
      headers: buildListUnsubscribeHeaders('https://app.example.com/v1/u/TOKEN'),
    });
    const init = (fetchImpl as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const simple = (body.Content as { Simple: Record<string, unknown> }).Simple;
    expect(simple.Headers).toEqual([
      { Name: 'List-Unsubscribe', Value: '<https://app.example.com/v1/u/TOKEN>' },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ]);
  });

  it('forwards multiple custom headers in order', async () => {
    const fetchImpl = fakeFetchOk({ MessageId: 'm3' });
    const c = new SesV2EmailClient({
      region: 'us-east-1',
      credentialsProvider: () => ({ accessKeyId: 'k', secretAccessKey: 's' }),
      fetchImpl,
    });
    await c.send({
      to: 'a@x',
      from: 'no-reply@x',
      subject: 's',
      html: 'h',
      text: 't',
      headers: [
        { name: 'List-Unsubscribe', value: '<https://x/u/1>' },
        { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
        { name: 'X-Tenant-Cohort', value: 'design-partner' },
      ],
    });
    const init = (fetchImpl as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const simple = (body.Content as { Simple: Record<string, unknown> }).Simple;
    expect(Array.isArray(simple.Headers)).toBe(true);
    expect((simple.Headers as Array<{ Name: string }>).map((h) => h.Name)).toEqual([
      'List-Unsubscribe',
      'List-Unsubscribe-Post',
      'X-Tenant-Cohort',
    ]);
  });
});
