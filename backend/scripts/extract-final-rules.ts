#!/usr/bin/env ts-node
/**
 * Final Rule extraction worker.
 *
 * Picks up source_document rows where:
 *   - extracted_at IS NULL
 *   - document_type IN ('cms_final_rule', 'mln_article', 'state_medicaid_manual')
 *   - storage_uri starts with file:// (local-disk uploads)
 *
 * For each: read PDF → extract text → run regex_v1 extractor → propose
 * candidates → insert into extraction_candidate. Mark source_document
 * with extracted_at + count.
 *
 *   ts-node scripts/extract-final-rules.ts [--limit N] [--dry-run]
 *
 * Run on a cron — once per hour is plenty since uploads are
 * analyst-driven, not high-volume. The worker is idempotent on the
 * `extracted_at IS NULL` predicate, so running it twice is a no-op
 * after the first sweep.
 *
 * The candidates this writes still go through the human-review queue.
 * regex_v1 confidence caps at ~0.45; nothing reaches the rule library
 * without an analyst's accept.
 */
import { readFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';
import {
  extractPdfText,
  findCodeMentions,
  proposeCandidates,
} from '../src/final-rules/extractor';

interface Args { dryRun: boolean; limit: number }

function parseArgs(): Args {
  const a: Args = { dryRun: false, limit: 50 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--limit') a.limit = parseInt(argv[++i], 10);
  }
  return a;
}

interface PendingDoc {
  id: string;
  url: string;
  document_type: string;
  title: string | null;
  storage_uri: string | null;
  payer_id: string | null;
  effective_date: Date | null;
}

async function findPending(pool: Pool, limit: number): Promise<PendingDoc[]> {
  const r = await pool.query<PendingDoc>(
    `SELECT id, url, document_type, title, storage_uri, payer_id, effective_date
       FROM source_document
       WHERE extracted_at IS NULL
         AND document_type IN ('cms_final_rule', 'mln_article', 'state_medicaid_manual')
         AND storage_uri IS NOT NULL
       ORDER BY retrieved_at ASC
       LIMIT $1`,
    [limit],
  );
  return r.rows;
}

async function processOne(
  pool: Pool,
  doc: PendingDoc,
  dryRun: boolean,
): Promise<{ candidate_count: number }> {
  if (!doc.storage_uri || !doc.storage_uri.startsWith('file://')) {
    throw new Error(`unsupported storage_uri: ${doc.storage_uri}`);
  }
  const localPath = doc.storage_uri.replace('file://', '');
  const buf = await readFile(localPath);

  let text = '';
  try {
    const { text: t } = await extractPdfText(buf);
    text = t;
  } catch (e) {
    // If the file isn't a PDF (e.g. analyst dropped a .txt), try as text.
    if (looksLikeText(buf)) {
      text = buf.toString('utf8');
    } else {
      throw new Error(`pdf parse failed: ${(e as Error).message}`);
    }
  }

  const mentions = findCodeMentions(text);
  const proposals = proposeCandidates(mentions);

  if (dryRun) {
    console.log(`  dry-run: would insert ${proposals.length} candidate(s) for ${doc.id}`);
    return { candidate_count: proposals.length };
  }

  // Insert candidates in a single transaction; mark the doc as
  // extracted regardless of whether we found anything (so we don't
  // re-process). Truncate the persisted text at 500KB to keep the
  // row reasonable; the full text is on disk if needed.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of proposals) {
      await client.query(
        `INSERT INTO extraction_candidate
           (source_doc_id, payer_id, code, attribute,
            proposed_value, proposed_coverage_status, proposed_confidence,
            proposed_effective_date,
            source_quote, source_page, extractor_name, status, priority)
         VALUES
           ($1, $2, $3, 'coverage_status',
            ($4)::jsonb, $5, $6,
            $7, $8, $9, $10, 'queued', 5)`,
        [
          doc.id,
          doc.payer_id,
          p.code,
          JSON.stringify({ rationale: p.rationale }),
          p.proposed_coverage_status,
          p.proposed_confidence.toFixed(2),
          doc.effective_date,
          p.source_quote,
          p.source_page,
          p.extractor_name,
        ],
      );
    }
    await client.query(
      `UPDATE source_document
          SET extracted_at = now(),
              extraction_candidate_count = $2,
              extracted_text = LEFT($3, 500000)
        WHERE id = $1`,
      [doc.id, proposals.length, text],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // Persist the failure so the next run skips this doc until an
    // operator clears extraction_error.
    await pool
      .query(
        `UPDATE source_document
            SET extraction_error = $2,
                extracted_at = now()
          WHERE id = $1`,
        [doc.id, (e as Error).message.slice(0, 1000)],
      )
      .catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { candidate_count: proposals.length };
}

function looksLikeText(buf: Buffer): boolean {
  // Heuristic: if the first 256 bytes are mostly printable ASCII, treat
  // as text. Real PDFs start with `%PDF-`, which is also printable but
  // not 80%+ ASCII; the % alone matches.
  if (buf.length === 0) return false;
  const head = buf.subarray(0, Math.min(256, buf.length));
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return false; // %PDF
  let printable = 0;
  for (const b of head) {
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable += 1;
  }
  return printable / head.length > 0.85;
}

async function main() {
  const args = parseArgs();
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    exit(2);
  }
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));

  const pending = await findPending(pool, args.limit);
  console.log(`Found ${pending.length} pending source_document(s).`);
  if (pending.length === 0) {
    await pool.end();
    exit(0);
  }

  let okCount = 0;
  let failCount = 0;
  let totalCandidates = 0;

  for (const doc of pending) {
    console.log(`\n→ ${doc.id} ${doc.document_type} "${doc.title}"`);
    try {
      const r = await processOne(pool, doc, args.dryRun);
      okCount += 1;
      totalCandidates += r.candidate_count;
      console.log(`  ok: ${r.candidate_count} candidate(s)`);
    } catch (e) {
      failCount += 1;
      console.error(`  FAILED: ${(e as Error).message}`);
    }
  }
  console.log(
    `\nSummary: ${okCount} processed, ${failCount} failed, ${totalCandidates} candidate(s) ${args.dryRun ? 'would-be-' : ''}written.`,
  );
  await pool.end();
  exit(failCount > 0 ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
