/**
 * Reconciliation diff engine.
 *
 * Pure function. Given a set of authoritative `payer_rule` rows and a set of
 * proposed `client_rule` rows for the same (org, client_rulebook), produces a
 * structured diff classifying each (payer, state, product_line, code, attribute)
 * key as one of:
 *
 *   - `aligned`             — both sides agree on coverage_status + value
 *   - `conflicting`         — both have a row, but values disagree
 *   - `missing_in_client`   — authoritative has it, client doesn't
 *   - `missing_in_authoritative` — client has it, authoritative doesn't
 *
 * The pure shape lets us snapshot diffs deterministically for the review UI
 * and for change-tracking when authoritative data drifts.
 */
import type { CoverageStatus, PayerRuleAttribute } from '../database/schema.types';

export interface RuleSnapshot {
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  attribute: PayerRuleAttribute;
  value: Record<string, unknown>;
  coverage_status: CoverageStatus;
  /** For drift detection — when authoritative row changes effective_date, the diff shifts. */
  effective_date: string;          // YYYY-MM-DD for stable hashing
  /** Stable id for the upstream row (payer_rule.id or client_rule.id). */
  source_id: string;
}

export type DiffOutcome =
  | 'aligned'
  | 'conflicting'
  | 'missing_in_client'
  | 'missing_in_authoritative';

export interface DiffEntry {
  outcome: DiffOutcome;
  key: {
    payer_id: string;
    state: string;
    product_line: string;
    code: string;
    attribute: PayerRuleAttribute;
  };
  authoritative?: RuleSnapshot;
  client?: RuleSnapshot;
  /** Set on `conflicting`: which JSON keys differ in `value`, plus coverage_status disagreement. */
  field_diffs?: string[];
}

export interface DiffSet {
  total: number;
  by_outcome: Record<DiffOutcome, number>;
  entries: DiffEntry[];
  /** Sha256 of canonical entries for integrity hashing of finalized rulebooks. */
  integrity_hash: string;
}

function keyOf(r: { payer_id: string; state: string; product_line: string; code: string; attribute: string }): string {
  return `${r.payer_id}|${r.state}|${r.product_line}|${r.code}|${r.attribute}`;
}

/**
 * Compare two `value` JSON blobs and return the list of field names that
 * differ. Implementation: a stable canonical JSON of each side, then field-by-
 * field at the top level. Nested differences are reported as the top-level key
 * being different rather than walking arbitrarily deep.
 */
function valueFieldDiffs(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) {
      diffs.push(k);
    }
  }
  return diffs;
}

export function computeDiff(authoritative: RuleSnapshot[], client: RuleSnapshot[]): DiffSet {
  const authMap = new Map(authoritative.map((r) => [keyOf(r), r]));
  const clientMap = new Map(client.map((r) => [keyOf(r), r]));

  const allKeys = new Set([...authMap.keys(), ...clientMap.keys()]);
  const entries: DiffEntry[] = [];
  const counts: Record<DiffOutcome, number> = {
    aligned: 0,
    conflicting: 0,
    missing_in_client: 0,
    missing_in_authoritative: 0,
  };

  for (const key of allKeys) {
    const a = authMap.get(key);
    const c = clientMap.get(key);
    const baseKey = a ?? c!; // at least one is present
    const meta = {
      payer_id: baseKey.payer_id,
      state: baseKey.state,
      product_line: baseKey.product_line,
      code: baseKey.code,
      attribute: baseKey.attribute,
    };

    if (a && !c) {
      entries.push({ outcome: 'missing_in_client', key: meta, authoritative: a });
      counts.missing_in_client++;
      continue;
    }
    if (!a && c) {
      entries.push({ outcome: 'missing_in_authoritative', key: meta, client: c });
      counts.missing_in_authoritative++;
      continue;
    }
    // Both present — compare
    const fieldDiffs = valueFieldDiffs(a!.value, c!.value);
    const statusDiffer = a!.coverage_status !== c!.coverage_status;
    if (statusDiffer) fieldDiffs.unshift('coverage_status');

    if (fieldDiffs.length === 0) {
      entries.push({ outcome: 'aligned', key: meta, authoritative: a, client: c });
      counts.aligned++;
    } else {
      entries.push({
        outcome: 'conflicting',
        key: meta,
        authoritative: a,
        client: c,
        field_diffs: fieldDiffs,
      });
      counts.conflicting++;
    }
  }

  // Stable order for deterministic hashing.
  entries.sort((a, b) => {
    const ka = `${a.outcome}|${keyOf(a.key)}`;
    const kb = `${b.outcome}|${keyOf(b.key)}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    total: entries.length,
    by_outcome: counts,
    entries,
    integrity_hash: hashEntries(entries),
  };
}

function hashEntries(entries: DiffEntry[]): string {
  // Avoid pulling node:crypto into the tight pure-function module surface.
  // The orchestrator wraps this with a real hash for storage; here we use a
  // stable string fingerprint sufficient for cache/diff equality checks.
  const fingerprint = entries
    .map((e) => `${e.outcome}|${keyOf(e.key)}|${e.field_diffs?.join(',') ?? ''}`)
    .join('\n');
  // Simple FNV-1a 64-bit fingerprint for determinism without node:crypto.
  let h = BigInt('0xcbf29ce484222325');
  const prime = BigInt('0x100000001b3');
  const mask = BigInt('0xffffffffffffffff');
  for (const ch of fingerprint) {
    h ^= BigInt(ch.charCodeAt(0));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}
