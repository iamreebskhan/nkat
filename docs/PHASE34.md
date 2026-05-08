# Phase 34 — Tenant Data Deletion (MSA § 7) + Audit-Log PII Redaction

## Why this phase

Two regulated capabilities the platform was missing:

1. **Right to deletion (MSA § 7.2)** — customers can request that we
   delete all their tenant data; we commit to completing within 30
   days. Without an in-product workflow, an admin would have to email
   us, we'd run a one-off SQL script, and the audit trail would be
   bad. We need a typed surface that records the request, enforces
   the 30-day grace floor, runs the deletion under a privileged role,
   and keeps a receipt.

2. **HIPAA right-to-amend break-glass** — `audit_log` payloads
   occasionally leak PHI/PII despite redaction-at-write. Customers
   under audit need a way to scrub a specific row's payload while
   preserving the row's identity (action, occurred_at, actor) so the
   timeline stays intact. Every redaction itself must be auditable.

## What landed

### Schema (`db/migrations/0022_phase34_tenant_deletion.sql`)

- `tenant_deletion_request` — state machine
  `requested → scheduled → executed | canceled | failed`. The
  `earliest_execute_at` column stores the 30-day grace floor;
  the executor refuses to run before that timestamp. RLS-protected,
  unique on `org_id` (only one pending deletion per tenant at a time
  is enforced via the `where status in ('requested','scheduled')`
  partial index in code; UNIQUE is at the schema level on `org_id`).

- `audit_log_redaction` — append-only log of every redaction. Stores
  the SHA-256 hash of the original payload (proves redaction
  happened without re-leaking content), the actor user, the reason,
  and the redaction type (`payload_scrub` keeps shape, replaces
  values with `[REDACTED]` / 0 / false / `[]`; `payload_remove`
  collapses to `{redacted: true}`). RLS-protected.

Both tables added via `app.apply_tenant_rls(...)`.

### Backend (`backend/src/admin/`)

- `tenant-deletion-pure.ts` — `earliestExecuteAt`,
  `validateConfirmationPhrase`, `isReadyForExecution`. The 30-day
  floor is enforced here — `Math.max(MIN_NOTICE_DAYS, requestedDays)`.
  Confirmation phrase is `DELETE-TENANT-<orgSlug>` — exact
  case-sensitive match prevents misclick deletions.

- `tenant-deletion.controller.ts` — three endpoints under
  `/v1/admin/tenant/delete`:
  - `POST` — request. Refuses if a pending request already exists
    (`409 DELETION_ALREADY_PENDING`). Validates the confirmation
    phrase (`400 CONFIRMATION_PHRASE_MISMATCH`). Computes the 30-day
    floor. Inserts the row + emits `audit_log` with action
    `tenant_deletion.request`.
  - `GET` — read the calling tenant's current request state.
  - `DELETE :id` — cancel. Only `requested|scheduled` states are
    cancelable; other states return `404 DELETION_NOT_PENDING`.

  All three use `runWithTenant` / `runReadOnlyWithTenant` so RLS
  applies even though the URL implies global admin scope.

- `audit-log-redaction.service.ts` — `hashPayload` (canonical
  sorted-key SHA-256), `computeRedactedPayload` (recursive scrub
  preserving shape), and the DB-touching `AuditLogRedactionService`
  that wraps the redaction in one transaction: read original →
  hash → update payload → insert `audit_log_redaction` row →
  insert meta-`audit_log` row recording the redaction itself.

- `audit-log-redaction.controller.ts` — `POST
  /v1/admin/audit-log/:id/redact`. Refuses to redact rows whose
  action is already `audit_log.redact` (those rows are the audit
  trail of redaction itself and must remain immutable;
  `400 CANNOT_REDACT_META_AUDIT`).

### Executor (`backend/scripts/execute-tenant-deletions.ts`)

- Connects with `BREAKGLASS_DATABASE_URL` (separate Secrets Manager
  binding from the app's regular DB URL). Refuses to start unless
  the role is BYPASSRLS — accidental runs as the `app` role would
  silently no-op due to RLS filters.
- Discovers RLS-protected tenant-scoped tables from the `pg_class`
  catalog at runtime — adding a new tenant table won't silently
  miss deletion compliance.
- Per pending request: `BEGIN; SET LOCAL statement_timeout = '300s';`
  delete from each table (skip `audit_log` if `retain_audit_log`,
  skip `tenant_deletion_request` itself, skip `org`); UPDATE the
  request to `executed`; if `retain_audit_log=false` also DELETE
  the `org` row (cascade catches anything missed).
- Failure path: ROLLBACK + UPDATE the request to `failed` with the
  error message (truncated to 1000 chars) so it's visible in the
  admin UI.
- `--dry-run` flag rolls back every transaction after reporting
  what it would have deleted.

### Schedule (`infra/terraform/scheduled-tasks.tf`)

- `aws_cloudwatch_event_rule.tenant_deletion_executor` — daily at
  13:00 UTC (separate from `cleanup_expired` at 11:00). Runs via the
  existing api task definition; `BREAKGLASS_DATABASE_URL` must be
  added to the api task's secrets list (TODO marker in `ecs.tf`).

### Tests

- `tenant-deletion-pure.spec.ts` — earliest-at / 30-day floor /
  confirmation phrase / ready-for-execution.
- `audit-log-redaction-pure.spec.ts` — canonicalize / hash stability
  / scrub semantics for each primitive type / nested objects / null
  preservation.
- Full unit suite: **611 / 611 passing** (was 584; +27 new tests).
- OpenAPI: **48 paths** (was 45; +3 new endpoints).

## Operational notes

- The MSA § 7 receipt is the row in `tenant_deletion_request`
  + the meta-row in `audit_log` (`tenant_deletion.request` action).
  Both survive (in `retain_audit_log=true` mode) past the deletion.
- A customer who re-signs-up after a `retain_audit_log=true`
  deletion gets a brand-new `org_id` (the original org row remains
  as a tombstone keeping the audit-log FK valid).
- For `retain_audit_log=false`, the `org` row CASCADEs everything;
  the customer's slug becomes available again.

## What remains

- Phase 35: per-tenant rate-limit overrides + JWKS pre-warm on boot.
- Phase 36: Stripe webhook signing-secret rotation, sidebar UI E2E.
- Phase 37: Datadog dashboards as Terraform, k6 load tests.
- Phase 38: final verification + integration runs.
