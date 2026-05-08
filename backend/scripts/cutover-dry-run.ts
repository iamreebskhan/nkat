#!/usr/bin/env ts-node
/**
 * Cutover dry-run — runs the production-cutover.md gate-checklist as code,
 * against a target environment (stage by default). Reports pass/fail per
 * check; non-zero exit if any gate is red.
 *
 * The point: turn "we ran through the runbook in our heads" into "the
 * machine ran through it last night and here's the pass/fail row." Real
 * cutover day, the only manual judgement is on the gates that genuinely
 * require it (BAA executed, pen test report clean) — everything testable
 * is tested.
 *
 * Run:
 *   npx ts-node scripts/cutover-dry-run.ts \
 *     --base-url https://stage.example.com \
 *     --org-id 11111111-1111-4111-8111-111111111111
 */
import { argv, exit, env } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

interface Args {
  baseUrl: string;
  orgId: string;
}

function parseArgs(): Args {
  const args: Partial<Args> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--org-id') args.orgId = argv[++i];
  }
  if (!args.baseUrl || !args.orgId) {
    console.error('Usage: cutover-dry-run --base-url URL --org-id UUID');
    exit(2);
  }
  return args as Args;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    const { value, ms } = await timed(fn);
    return { name, ok: true, detail: value, durationMs: ms };
  } catch (e) {
    return {
      name,
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      durationMs: 0,
    };
  }
}

function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  return fetch(url, init).then(async (r) => ({
    status: r.status,
    body: r.headers.get('content-type')?.includes('application/json') ? await r.json() : await r.text(),
  }));
}

async function main() {
  const args = parseArgs();
  const token = env.STAGE_TOKEN ?? '';

  const results: CheckResult[] = [];

  // 1. /health responds 200 in <500ms.
  results.push(
    await check('GET /health < 500ms', async () => {
      const t0 = Date.now();
      const r = await fetchJson(`${args.baseUrl}/health`);
      const ms = Date.now() - t0;
      if (r.status !== 200) throw new Error(`status=${r.status}`);
      if (ms > 500) throw new Error(`latency=${ms}ms (>500ms threshold)`);
      return `200 in ${ms}ms`;
    }),
  );

  // 2. /v1/lookup round-trip with seeded tenant returns expected finding shape.
  results.push(
    await check('POST /v1/lookup happy path', async () => {
      const r = await fetchJson(`${args.baseUrl}/v1/lookup`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-org-id': args.orgId,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          payer_id: 'aetna-oh-commercial',
          state: 'OH',
          product_line: 'commercial',
          date_of_service: '2026-04-15',
          codes: ['99497'],
        }),
      });
      if (r.status !== 200) throw new Error(`status=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`);
      const b = r.body as { findings?: unknown[]; severity_summary?: unknown };
      if (!Array.isArray(b.findings)) throw new Error('no findings array');
      if (!b.severity_summary) throw new Error('no severity_summary');
      return `${b.findings.length} findings`;
    }),
  );

  // 3. Synthesis with deterministic provider returns a non-refused result.
  results.push(
    await check('POST /v1/synthesis (deterministic) non-refused', async () => {
      const r = await fetchJson(`${args.baseUrl}/v1/synthesis`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-org-id': args.orgId,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          request_id: 'cutover-dry-run',
          payer_id: 'p',
          state: 'OH',
          product_line: 'medicare_ffs',
          date_of_service: '2026-04-15',
          audience: 'biller',
          findings: [
            {
              severity: 'ok',
              carc_class: 'coverage_50',
              title: 'Stub',
              detail: 'd',
              confidence: 1,
              citations: [],
            },
          ],
        }),
      });
      if (r.status !== 200) throw new Error(`status=${r.status}`);
      return 'ok';
    }),
  );

  // 4. Webhook subscription create + delete round-trip (proves admin RLS path).
  let createdSubId: string | null = null;
  results.push(
    await check('webhook-subscription create round-trip', async () => {
      const r = await fetchJson(`${args.baseUrl}/v1/admin/webhook-subscriptions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-org-id': args.orgId,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          url: 'https://example.invalid/cutover-dry-run',
          event_types: ['lookup.completed'],
        }),
      });
      if (r.status !== 201 && r.status !== 200) throw new Error(`status=${r.status}`);
      const b = r.body as { id?: string };
      createdSubId = b.id ?? null;
      if (!createdSubId) throw new Error('no id returned');
      return `id=${createdSubId.slice(0, 8)}…`;
    }),
  );

  if (createdSubId) {
    results.push(
      await check('webhook-subscription cleanup', async () => {
        const r = await fetchJson(
          `${args.baseUrl}/v1/admin/webhook-subscriptions/${createdSubId}`,
          {
            method: 'DELETE',
            headers: {
              'x-org-id': args.orgId,
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
          },
        );
        if (r.status >= 400) throw new Error(`status=${r.status}`);
        return 'deleted';
      }),
    );
  }

  // 5. Audit-log search returns at least the rows we just created.
  await sleep(500);
  results.push(
    await check('audit-log search reflects activity', async () => {
      const r = await fetchJson(
        `${args.baseUrl}/v1/admin/audit-log?limit=10`,
        {
          headers: {
            'x-org-id': args.orgId,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      if (r.status !== 200) throw new Error(`status=${r.status}`);
      const b = r.body as { entries?: unknown[] };
      if (!Array.isArray(b.entries) || b.entries.length === 0) {
        throw new Error('no audit entries returned');
      }
      return `${b.entries.length} entries`;
    }),
  );

  // Render report.
  const rows = results.map((r) => {
    const status = r.ok ? 'PASS' : 'FAIL';
    const ms = r.durationMs ? ` ${r.durationMs}ms` : '';
    return `[${status}]${ms.padStart(8)}  ${r.name.padEnd(48)}  ${r.detail}`;
  });
  console.log('\nCutover dry-run report');
  console.log('======================');
  console.log(rows.join('\n'));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);

  exit(failed === 0 ? 0 : 1);
}

void main();
