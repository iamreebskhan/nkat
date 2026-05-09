#!/usr/bin/env ts-node
/**
 * Unified stage health-check. One script that runs the four major
 * smoke flows in sequence, summarizes pass/fail, and non-zero exits if
 * anything red. Useful as the human-facing handoff at the end of a
 * dress rehearsal.
 *
 * Checks:
 *   1. cutover-dry-run (HTTP smoke against the API)
 *   2. billing reconcile (--dry-run only)
 *   3. signup-attempt cleanup (--dry-run only)
 *   4. send-billing-emails (--dry-run only)
 *
 * The individual scripts have their own exit codes; we collect and
 * report. Run:
 *   ts-node scripts/stage-health-check.ts --base-url https://stage.example.com --org-id ...
 */
import { argv, env, exit } from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';

interface Step {
  name: string;
  cmd: string;
  args: string[];
}

function arg(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function runStep(step: Step): Promise<{ name: string; ok: boolean; durationMs: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(step.cmd, step.args, { stdio: 'inherit', env: process.env, shell: true });
    p.on('exit', (code) =>
      resolve({ name: step.name, ok: code === 0, durationMs: Date.now() - t0 }),
    );
    p.on('error', () => resolve({ name: step.name, ok: false, durationMs: Date.now() - t0 }));
  });
}

async function main() {
  const baseUrl = arg('--base-url');
  const orgId = arg('--org-id');
  if (!baseUrl || !orgId) {
    console.error('Usage: stage-health-check --base-url URL --org-id UUID');
    exit(2);
  }
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required for the dry-run checks');
    exit(2);
  }

  const here = path.resolve(__dirname);
  const tsNode = `"${path.resolve(here, '..', 'node_modules', '.bin', 'ts-node')}"`;

  const steps: Step[] = [
    {
      name: 'cutover-dry-run',
      cmd: tsNode,
      args: [
        `"${path.join(here, 'cutover-dry-run.ts')}"`,
        '--base-url',
        baseUrl,
        '--org-id',
        orgId,
      ],
    },
    {
      name: 'billing-reconcile (dry)',
      cmd: tsNode,
      args: [`"${path.join(here, 'reconcile-billing.ts')}"`, '--dry-run'],
    },
    {
      name: 'signup-expire (dry)',
      cmd: tsNode,
      args: [`"${path.join(here, 'expire-signup-attempts.ts')}"`, '--dry-run'],
    },
    {
      name: 'billing-emails (dry)',
      cmd: tsNode,
      args: [`"${path.join(here, 'send-billing-emails.ts')}"`, '--dry-run'],
    },
  ];

  const results: Array<{ name: string; ok: boolean; durationMs: number }> = [];
  for (const step of steps) {
    console.log(`\n=== ${step.name} ===`);
    results.push(await runStep(step));
  }

  console.log('\n');
  console.log('Stage health-check report');
  console.log('=========================');
  for (const r of results) {
    console.log(
      `  [${r.ok ? 'PASS' : 'FAIL'}] ${r.durationMs.toString().padStart(6)}ms  ${r.name}`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} steps passed.`);
  exit(failed === 0 ? 0 : 1);
}

void main();
