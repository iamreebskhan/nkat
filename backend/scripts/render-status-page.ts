#!/usr/bin/env ts-node
/**
 * Render the public status page (status.example.com) by polling
 * `GET /status` and writing a self-contained HTML file. Operator
 * publishes the file to S3 + CloudFront. Uses no external deps
 * (no React, no template engine — just template literals).
 *
 *   ts-node scripts/render-status-page.ts \
 *     --base https://api.example.com \
 *     --out  ./public/status.html \
 *     --history-file ./public/status-history.json   (optional)
 *
 * The history file is appended-to with the latest snapshot so the
 * rendered page can show a 30-day uptime stripe without a database.
 */
import { argv, exit } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface Args {
  base: string;
  out: string;
  historyFile: string | null;
  historyDays: number;
}

function parseArgs(): Args {
  const a: Args = { base: '', out: '', historyFile: null, historyDays: 30 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--base') a.base = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--history-file') a.historyFile = argv[++i];
    else if (argv[i] === '--history-days') a.historyDays = parseInt(argv[++i], 10);
  }
  return a;
}

interface ComponentStatus {
  name: string;
  status: 'operational' | 'partial_outage' | 'major_outage' | 'not_configured';
  latency_ms?: number;
  detail?: string;
}

interface StatusResponse {
  status: 'operational' | 'partial_outage' | 'major_outage';
  version: string;
  uptime_sec: number;
  checked_at: string;
  components: ComponentStatus[];
}

interface HistorySnapshot {
  ts: string;
  status: StatusResponse['status'];
}

async function readHistory(path: string | null): Promise<HistorySnapshot[]> {
  if (!path) return [];
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function pruneHistory(h: HistorySnapshot[], days: number): HistorySnapshot[] {
  const cutoff = Date.now() - days * 86_400_000;
  return h.filter((s) => new Date(s.ts).getTime() >= cutoff);
}

function statusClass(s: string): string {
  switch (s) {
    case 'operational': return 'ok';
    case 'partial_outage': return 'warn';
    case 'major_outage': return 'down';
    default: return 'na';
  }
}

function statusLabel(s: string): string {
  switch (s) {
    case 'operational': return 'All systems operational';
    case 'partial_outage': return 'Partial outage';
    case 'major_outage': return 'Major outage';
    default: return 'Status unknown';
  }
}

function renderHtml(snap: StatusResponse, history: HistorySnapshot[]): string {
  const stripeBuckets: Array<{ day: string; status: string }> = [];
  // Bucket history by UTC day.
  const byDay = new Map<string, string[]>();
  for (const s of history) {
    const day = s.ts.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(s.status);
  }
  // Worst per day wins for the stripe.
  const order = ['operational', 'partial_outage', 'major_outage'];
  for (const [day, statuses] of [...byDay.entries()].sort()) {
    let worst = statuses[0];
    for (const s of statuses) {
      if (order.indexOf(s) > order.indexOf(worst)) worst = s;
    }
    stripeBuckets.push({ day, status: worst });
  }

  const compRows = snap.components
    .map((c) => `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td><span class="dot ${statusClass(c.status)}"></span> ${statusLabel(c.status)}</td>
        <td>${c.latency_ms ?? '-'} ms</td>
      </tr>`)
    .join('');

  const stripeHtml = stripeBuckets
    .map(
      (b) =>
        `<span class="stripe ${statusClass(b.status)}" title="${b.day}: ${statusLabel(b.status)}"></span>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Status — Billing Rules Platform</title>
<style>
  body { font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  .summary { padding: 20px; border-radius: 8px; font-size: 18px; font-weight: 600; }
  .ok { background: #d4edda; color: #155724; }
  .warn { background: #fff3cd; color: #856404; }
  .down { background: #f8d7da; color: #721c24; }
  .na { background: #e2e3e5; color: #383d41; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot.ok { background: #28a745; }
  .dot.warn { background: #ffc107; }
  .dot.down { background: #dc3545; }
  .dot.na { background: #6c757d; }
  table { border-collapse: collapse; margin-top: 24px; width: 100%; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { background: #f6f8fa; }
  .stripe { display: inline-block; width: 8px; height: 24px; margin-right: 1px; }
  .meta { color: #666; font-size: 14px; margin-top: 24px; }
</style>
</head>
<body>
<h1>Billing Rules Platform — Status</h1>
<div class="summary ${statusClass(snap.status)}">${statusLabel(snap.status)}</div>

<h2>Components</h2>
<table>
  <thead><tr><th>Component</th><th>Status</th><th>Latency</th></tr></thead>
  <tbody>${compRows}</tbody>
</table>

${stripeBuckets.length > 0 ? `
<h2>Last ${stripeBuckets.length} day(s)</h2>
<div>${stripeHtml}</div>
` : ''}

<p class="meta">
  Build ${escapeHtml(snap.version)} · uptime ${formatUptime(snap.uptime_sec)} ·
  checked ${escapeHtml(snap.checked_at)}
</p>
<p class="meta">Subscribe to incident updates: status@example.com</p>
</body>
</html>`;
}

function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3600);
  return `${days}d ${hours}h`;
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function main() {
  const args = parseArgs();
  if (!args.base || !args.out) {
    console.error('--base <api-url> --out <html-file> required');
    exit(2);
  }
  const url = `${args.base.replace(/\/$/, '')}/status`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    console.error(`status fetch failed: ${r.status}`);
    exit(1);
  }
  const snap = (await r.json()) as StatusResponse;

  let history = await readHistory(args.historyFile);
  history.push({ ts: snap.checked_at, status: snap.status });
  history = pruneHistory(history, args.historyDays);
  if (args.historyFile) {
    await mkdir(dirname(args.historyFile), { recursive: true });
    await writeFile(args.historyFile, JSON.stringify(history, null, 2));
  }

  const html = renderHtml(snap, history);
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, html);
  console.log(`wrote ${args.out} (${html.length} bytes); status=${snap.status}`);
  exit(0);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
