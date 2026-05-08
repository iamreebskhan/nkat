# Synthesis Cache Management

The `synthesis_cache` table caches LLM-generated narratives keyed by
`(org_id, content_hash)` with a 7-day TTL. The hash includes a global
`synthesis_cache.version` from `system_setting` so a single counter
bump invalidates every cached row platform-wide.

This runbook covers when + how to invalidate the cache safely under the
common operational conditions.

---

## When the cache invalidates automatically

`db/migrations/0021_phase26_cache_triggers.sql` installs **statement-level**
triggers on every table whose contents drive lookup findings. Any
INSERT/UPDATE/DELETE statement against these tables bumps the version
exactly once per statement (not per row):

- `payer_rule`
- `ncci_ptp`
- `ncci_mue`
- `documentation_requirement`
- `mhpaea_parity_pair`
- `dme_master_list`
- `asc_payment_indicator`
- `wc_state_fee_schedule`
- `hcc_mapping`
- `cob_rule`

A typical quarterly NCCI import touches 5–10 statements (one per chunk
or one per file), so the cache version bumps 5–10 times. That's fine —
each bump's effect is identical (every row's hash is now stale; new
lookups produce fresh rows under the new version).

---

## When to invalidate manually

Three scenarios:

1. **Bulk import behind `session_replication_role = replica`** (see
   below). After committing the bulk insert, run the manual bump so
   downstream synthesis re-renders.

2. **Rule semantics changed without changing the row data**. Example:
   the synthesis prompt template changed (Bedrock model swap). No
   data row mutated, but the produced narrative will differ. Bump.

3. **Compliance audit** says "demonstrate cache rollover within N
   minutes." Run the bump from the operator shell; verify via:

   ```sql
   SELECT key, value, updated_by_user_id, note, updated_at
   FROM system_setting WHERE key = 'synthesis_cache.version';
   ```

### How to bump

Two paths, same effect:

```bash
# Option A — admin API (with auth)
curl -X POST https://prod.example.com/v1/admin/cache/invalidate \
  -H "x-org-id: <admin-tenant>" -H "content-type: application/json" \
  -d '{"note":"prompt-template-v2-deploy"}'

# Option B — CLI (e.g. from a CI/CD step)
DATABASE_URL=postgres://... npm run cache:invalidate -- --note "ncci-2026-q3-deploy"
```

Both write `system_setting.synthesis_cache.version` and refresh the
in-process 60s TTL on the calling API task. Other API tasks pick up the
new version within ~60s.

---

## Bulk imports that want to skip per-statement bumps

For a large multi-statement import, the auto-trigger fires once per
statement which is usually fine. But if you want to ATOMICALLY land
the whole import without intermediate cache invalidations (e.g., to
keep the cache hit rate stable until the whole import is committed),
disable the triggers for the session:

```sql
BEGIN;
SET LOCAL session_replication_role = replica;  -- skips user triggers
-- ... bulk imports here, possibly across many statements ...
COMMIT;
-- Now bump explicitly:
\! npm run cache:invalidate -- --note "ncci-bulk-import-2026-q3"
```

`session_replication_role = replica` is Postgres's standard "skip
user-defined triggers" knob. The rule-source tables aren't replication
targets, so this disables the trigger cleanly without affecting any
other behavior.

**WARNING**: forgetting the post-commit explicit `cache:invalidate` is
a common mistake. The post-import cache will silently serve stale
narratives until the natural 7-day TTL elapses. Standard pattern:
always pair the SET with the bump; ideally script them together.

---

## Verifying the trigger fired

After any rule-source mutation, the version should have incremented:

```sql
SELECT key, value, note, updated_at
FROM system_setting
WHERE key = 'synthesis_cache.version';
-- Expect:
--   value     = <previous + 1>
--   note      = 'auto: payer_rule INSERT'  (or similar)
--   updated_at = now()-ish
```

If `note` doesn't match `auto: <table> <op>`, the trigger may have been
skipped (e.g., empty INSERT, the `WHEN (EXISTS ...)` guard fired).

---

## Operator-side troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Cache returns stale narratives after a rule deploy | Trigger disabled (`session_replication_role`) and explicit bump forgotten | `npm run cache:invalidate -- --note "post-import"` |
| Cache hit rate drops to 0 after deploy | Cache-version bumped but cleanup hasn't run; that's expected first-pass behavior — should recover in 1-3 cycles | none — wait + monitor |
| Cache version growing fast (e.g., 1000+/day) | Lots of rule-source mutations | Healthy; not a problem. Version is BIGINT-shaped. |
| Cache version stuck at 1 | Triggers absent (migration 0021 didn't apply) OR `system_setting` row missing | Verify `\d system_setting` schema + re-seed: `INSERT INTO system_setting (key, value) VALUES ('synthesis_cache.version', '1'::jsonb) ON CONFLICT DO NOTHING;` |

---

## Cleanup vs invalidation — different things

- **Invalidation** (this runbook): bumps the version; new lookups
  re-cache under the new version; old rows still in the table but
  no longer match new hash queries. Cheap, fast, no DELETE.

- **Cleanup** (`scripts/cleanup-expired-records.ts`): DELETEs cache rows
  past their `expires_at` (7-day TTL). Runs daily as a scheduled
  EventBridge task.

Don't conflate. Bumping the version doesn't physically remove rows;
cleanup does. The two surfaces compose: bump invalidates logically,
cleanup reclaims storage.
