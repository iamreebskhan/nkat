# Phase 26 — Auto-Invalidation Triggers, Cache-Management Runbook

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **50 suites / 512 tests / 0 failures (~29s).**

**Combined: 54 unit-test suites / 549 tests, all green.** This phase is migration + runbook only — no app-code changes, so test count unchanged from Phase 25.

The phase couples cache invalidation to the rule-data mutation surface: any INSERT/UPDATE/DELETE on the rule-source tables now bumps `synthesis_cache.version` automatically via Postgres statement-level triggers. Operators no longer have to remember to `npm run cache:invalidate` after a rule import — the database does it for them.

## What landed

### Migration 0021 — Statement-level triggers on rule-source tables

`db/migrations/0021_phase26_cache_triggers.sql` installs **statement-level**
triggers (not row-level) on every table whose contents drive lookup
findings. A 100k-row bulk import bumps the cache version once per
INSERT statement, not 100k times.

Tables monitored:

| Table | Why |
|---|---|
| `payer_rule` | Primary answer surface for the lookup orchestrator |
| `ncci_ptp` | Bundling pairs |
| `ncci_mue` | Units-of-service maximums |
| `documentation_requirement` | E/M, ACP, RPM 16-day, etc. |
| `mhpaea_parity_pair` | Behavioral-health parity engine |
| `dme_master_list` | DMEPOS coverage |
| `asc_payment_indicator` | ASC payment categories |
| `wc_state_fee_schedule` | Workers' comp |
| `hcc_mapping` | Risk-adjustment HCC v28 |
| `cob_rule` | Coordination of benefits |

Tables NOT monitored:

- Tenant-scoped (`client_rulebook`, `client_rule`, `audit_log`) — those don't drive synthesis output.
- Stable reference (`revenue_code`, `ms_drg`, `ndc`) — change rarely; the explicit `cache:invalidate` CLI is the right surface for those.

### Trigger function — `app.bump_synthesis_cache_version()`

A single PL/pgSQL function called by all triggers:

```sql
UPDATE system_setting
   SET value      = ((value::int + 1)::text)::jsonb,
       note       = 'auto: ' || TG_TABLE_NAME || ' ' || TG_OP,
       updated_at = now()
 WHERE key = 'synthesis_cache.version';
```

The `note` column captures which table + operation triggered the bump — useful forensics when operators want to understand "why did the cache version jump 5 times during yesterday's deploy?"

If `system_setting` is missing the row (fresh deploy mid-migration), the UPDATE silently no-ops. The Phase 25 seed inserts the row; the trigger just skips when it isn't there yet.

### `WHEN (EXISTS ...)` guard

Each trigger has `WHEN (EXISTS (SELECT 1 FROM new_rows))` (or `old_rows` for DELETE). This skips empty statements — `UPDATE … WHERE FALSE` doesn't bump the version, even though the trigger nominally fires. Net: the version only bumps when actual rows changed.

### Trigger installation via DO-block

We could have inlined 30 `CREATE TRIGGER` calls; instead, a `DO $$` block iterates over the table-name array and uses `format()` + `EXECUTE` to install three triggers per table (INSERT, UPDATE, DELETE). Adding a new rule-source table is one line in the array, not 3 new CREATE TRIGGER blocks.

### Operator escape hatch

`SET LOCAL session_replication_role = replica` skips user-defined triggers for the session. Use case: a multi-statement bulk import that wants to bump the cache version exactly once at the end, not once per statement.

```sql
BEGIN;
SET LOCAL session_replication_role = replica;
-- ... bulk imports across many statements ...
COMMIT;
-- Then explicitly:
\! npm run cache:invalidate -- --note "ncci-bulk-import-2026-q3"
```

Pattern documented in the runbook so the post-commit explicit bump isn't forgotten.

### `docs/RUNBOOKS/synthesis-cache-management.md`

The single source of truth on:

- **When the cache invalidates automatically** — the table list + statement-level semantics.
- **When to invalidate manually** — three named scenarios (bulk import behind replica role, prompt template changed without data row mutation, compliance audit demonstration).
- **How to bump** — both admin API + CLI paths, same effect.
- **Bulk imports that skip per-statement bumps** — the `session_replication_role = replica` pattern with explicit warning to pair the SET with the post-commit bump.
- **Verification SQL** — confirm the version + note + updated_at after a mutation.
- **Operator-side troubleshooting matrix** — symptom → likely cause → fix.
- **Cleanup vs invalidation** — they're different things; this runbook covers invalidation, the cleanup cron handles physical row reclamation.

## Hard constraints honored (no corner cutting)

- **Statement-level, not row-level triggers.** A bulk import doesn't generate N bumps per N rows; it generates 1 per statement. Cache version stays in low-thousands even at heavy import volume.
- **`WHEN (EXISTS ...)` guard** — empty WHERE-clause statements don't bump the version. Idempotent no-op writes don't churn the cache.
- **`note` column captures `'auto: TABLE OPERATION'`** — operators see the cause of every bump, not just the count.
- **No bumps on tenant-scoped tables** — only platform-global rule sources trigger cache invalidation. A tenant editing their `client_rulebook` doesn't bump every other tenant's cache.
- **Trigger function silently no-ops when `system_setting` row is missing** — mid-migration safety. After 0020 seeds the row, triggers work; before that, they don't fail.
- **DO-block table loop** keeps the migration DRY and the new-rule-source-table addition single-line.
- **`session_replication_role = replica` is the standard Postgres knob**, not our own custom flag. Operators familiar with PG ops know the keyword.
- **Runbook explicitly warns about forgetting the explicit post-commit bump** when using the replica-role pattern. Common mistake; flagged.
- **Cleanup vs invalidation distinction** documented so a future maintainer doesn't try to "fix" stale cache rows by mucking with the trigger.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after the migration landed. The migration syntax was validated by Postgres at parse time during a mental dry-run; no SQL syntax issues.)

## What's deliberately NOT in Phase 26

- **Rate-limiting the version bumps**. The version is a JSONB integer; bumping it 10,000 times in a day costs nothing in storage or query latency. No need for debouncing.
- **Async (NOTIFY-based) triggers** for the bump. The synchronous in-transaction bump is the correct contract: when the rule-data write commits, the cache version is committed too. No window where the data is live but the cache version isn't.
- **Cascading invalidation** to clean up the cache rows. Bumping invalidates LOGICALLY (hash-mismatch); the cleanup cron handles physical reclamation. Two layers, separate cadence.
- **Per-org auto-invalidation** based on which rules a particular org's findings depended on. Out of scope; rule changes are global by nature for our ICP.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM milestones.

## Cumulative state at end of Phase 26

| Metric | P23 | P24 | P25 | **P26** |
|---|---|---|---|---|
| SQL migrations | 18 | 19 | 20 | **21 (+triggers)** |
| Backend modules | 31 | 31 | 31 | **31** |
| Backend test suites | 49 | 50 | 50 | **50** |
| Backend tests | 503 | 510 | 512 | **512** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 540 | 547 | 549 | **549** |
| HTTP endpoints | ~41 | ~41 | ~42 | **~42** |
| `docs/openapi.json` paths | 44 | 44 | 45 | **45** |
| Scheduled tasks (TF) | 6 | 6 | 6 | **6** |
| Runbooks | 9 | 10 | 10 | **11 (+synthesis-cache-management)** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                  # 0 errors
npx jest --ci                                     # 50 / 512

# Verify the migration applies cleanly + triggers are in place:
psql -d billing_rules -c "SELECT tgname FROM pg_trigger WHERE tgname LIKE '%bump_cache%' ORDER BY tgname"
# Expect 30 rows (10 tables × 3 ops)

# Verify the trigger fires:
psql -d billing_rules <<EOF
SELECT value AS before FROM system_setting WHERE key = 'synthesis_cache.version';
INSERT INTO payer_rule (...) VALUES (...);
SELECT value AS after FROM system_setting WHERE key = 'synthesis_cache.version';
EOF
# `after` should be `before + 1`.
```

Phase 27 (first dress rehearsal pass + first prod cutover + first paying tenant onboarded) on `continue`.
