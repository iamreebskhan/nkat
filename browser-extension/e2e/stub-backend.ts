/**
 * Stub backend for sidebar E2E. A 60-line Node `http` server that:
 *
 *   - Returns a deterministic LookupResponse for any POST /v1/lookup body.
 *   - Echoes back the requested codes so the spec can assert the round-trip.
 *   - Sets permissive CORS so the extension's chrome-extension:// origin
 *     can reach it (the prod backend uses a strict allowlist).
 *
 * Run standalone:  npx ts-node e2e/stub-backend.ts
 * Programmatic:    `import { startStub } from './stub-backend';`
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubServerHandle {
  url: string;
  close: () => Promise<void>;
}

const SAMPLE_CITATION = {
  source_doc_id: '00000000-0000-0000-0000-000000000001',
  source_url: 'https://www.cms.gov/medicare/medicare-coverage-database',
  retrieved_at: '2026-04-01T00:00:00Z',
  effective_date: '2026-01-01',
  verbatim_quote: 'Stub citation for E2E.',
};

function buildResponse(reqBody: { codes?: string[] }): unknown {
  const codes = Array.isArray(reqBody.codes) ? reqBody.codes : [];
  return {
    request_id: 'stub-r1',
    findings: codes.map((code, i) => ({
      severity: i === 0 ? 'ok' : 'warning',
      carc_class: 'coverage_50',
      title: `Stub finding for ${code}`,
      detail: `${code} resolved through the stub backend.`,
      confidence: 1,
      citations: [SAMPLE_CITATION],
    })),
    severity_summary: {
      critical: 0,
      warning: Math.max(0, codes.length - 1),
      info: 0,
      ok: codes.length > 0 ? 1 : 0,
    },
    refused: false,
  };
}

export async function startStub(): Promise<StubServerHandle> {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-org-id, x-user-id');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url?.startsWith('/v1/lookup')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: { codes?: string[] } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          /* tolerate empty body for the smoke path */
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(buildResponse(body)));
      });
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

// Allow running standalone: `npx ts-node e2e/stub-backend.ts`
if (require.main === module) {
  void startStub().then((h) => {
    // eslint-disable-next-line no-console
    console.log(`stub backend listening at ${h.url}`);
  });
}
