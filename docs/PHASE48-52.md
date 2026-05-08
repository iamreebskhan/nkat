# Phases 48–52 — Final cleanup batch

User said "do it" to the 1–10 punch list from the audit. All ten items
are now in code.

## Numbers

| | Phase 47 baseline | Now |
|---|---|---|
| Unit suites | 68 | **69** |
| Unit tests | 696 | **713** (+17) |
| Failures | 0 | **0** |
| OpenAPI paths | 63 | **64** |
| Integration suites | 9 | **10** (+ Phase 34–46 surfaces) |

## Items 1–10 — closed

1. **SCIM Groups** — `ScimGroupsController` reads
   admin/reviewer/employee/consultant as RFC 7643 Groups, members
   keyed off `org_member.role`. Discovery endpoint advertises Group
   resource type. Group IDs are deterministic (`role@orgId`).

2. **270 dependent coverage** — `Edi270Information.dependent` field;
   when supplied, the generator emits HL=4 + INS + NM1\*03 + DMG +
   DTP*291 under the subscriber and flips the subscriber's
   has-children flag. Tested.

3. **837P COB / Loop 2320** — `Edi837Claim.secondaryPayer` field;
   emits SBR (S/T) + AMT*D + OI + other-subscriber NM1*IL +
   other-payer NM1*PR. SE count updates correctly. Tested.

4. **837I institutional generator** —
   `src/ingestion/edi837/generator-institutional.ts`. UB-04 type-of-bill
   split into `facility:A:freq` for CLM05; SV2 service lines with
   revenue codes (validated 4-digit); HI segments for principal /
   admitting / other diagnoses, MS-DRG, condition / occurrence /
   value codes; CL1 + DTP*435 admission info when supplied.
   Endpoint `POST /v1/edi/837i`. 12 tests covering hospice + outpatient.

5. **`security.txt` (RFC 9116)** — `WellKnownController` at
   `/.well-known/security.txt` with mandatory Expires field
   computed at request time (one year out). Includes Contact,
   Encryption, Canonical, Policy fields.

6. **WMHMDA Consumer Health Data Privacy Policy** —
   `/.well-known/wmhmda-policy` serves the markdown text. Counsel-
   reviewable as a single string in `well-known.controller.ts`.
   Notice library actions reference it.

7. **Static status page renderer** —
   `backend/scripts/render-status-page.ts` polls `/status` JSON,
   appends to a JSON history file, renders self-contained HTML
   (no React, no template engine — template literals + inline CSS).
   30-day uptime stripe with "worst-status-per-day wins" semantics.
   `npm run render:status` exposed.

8. **Sentry-equivalent error reporting** —
   `src/observability/error-reporter.ts` exposes `IErrorReporter`
   interface + `DatadogErrorReporter` implementation that emits
   structured JSON log lines the Datadog Agent forwards into
   Error Tracking. `ERROR_REPORTER_TOKEN` exported globally.
   `NoopErrorReporter` for tests.

9. **DSAR auto-expiry** —
   `backend/scripts/expire-dsar.ts`. Finds `dsar_request` rows
   past `due_at + 7d` still in `received|verified`, flips to
   `expired`, inserts `privacy.dsar_auto_expired` audit row as
   SOC 2 SLA-miss evidence. Wired into EventBridge daily at
   14:00 UTC in `infra/terraform/scheduled-tasks.tf`.
   `npm run expire:dsar` exposed.

10. **Integration tests for the new endpoints** —
    `test/integration/phase34-46-surfaces.spec.ts` covers RLS
    isolation + cross-tenant SECURITY DEFINER functions for:
    - `tenant_deletion_request` (UNIQUE on org_id; RLS hides cross-tenant)
    - `rate_limit_override` + `app.list_active_rate_limit_overrides()`
      (expired rows filtered out; tenant isolation)
    - `scim_token` + `app.lookup_scim_token()` (cross-tenant lookup; RLS)
    - `dsar_request` 45-day due_at clock
    - `audit_log_redaction` RLS isolation

## Final state of the platform

- **69 unit test suites, 713 unit tests, all passing.**
- **64 OpenAPI paths.**
- **10 integration suites** (the Phase 34–46 surfaces suite gates
  on real Postgres via testcontainers, runs in CI).
- **25 migrations**, every RLS-protected table covered.
- Datadog dashboards + monitors as Terraform; metrics emitted by
  the application; k6 smoke + nightly load posted to Datadog.
- BREAKGLASS DB credential plumbed through Secrets Manager + IAM
  + ECS task secrets; tenant-deletion executor uses it.
- Forward-only migration runner with drift detection (Sqitch-style).
- SCIM 2.0 Users + Groups for Okta + Azure AD/Entra provisioning.
- ABN CMS-R-131 PDF generation.
- HCC v28 + RxHCC API surface.
- 270 (subscriber + dependent) and 271 EDI; 837P (with COB) and 837I
  generators; 835 ERA ingestion.
- NCCI / MS-DRG / LCD / NCD ingestion pipelines + cron schedules.
- Privacy: WMHMDA, CCPA/CPRA, CPA, VCDPA, TDPSA, AB 3030, CO SB24-205
  notice library + DSAR fulfillment with 45-day clock + auto-expiry.
- Per-tenant rate-limit overrides with O(1) cache + force-refresh.
- Stripe webhook signing-secret rotation with `secretIndex` telemetry.
- Tenant-data-deletion (MSA § 7) executor with 30-day floor +
  audit-log redaction break-glass.
- JWKS prewarm on bootstrap.
- `/.well-known/security.txt` + WMHMDA policy.
- Static status-page renderer + `/status` JSON.
- `IErrorReporter` interface + Datadog implementation.

## What is genuinely still out of scope from this seat

- **Live external service wiring** (Bedrock prod, Stripe-prod,
  Auth0/Cognito, SES) — accounts + keys, not code.
- **Pen test, SOC 2 audit, counsel-signed memos** — humans + auditors.
- **Frontend web app** — separate workstream.
- **Specialty rule data content** — pipelines exist, the curated
  oncology / WC / IHS content needs a content team's source files.
- **AMA CPT license + procurement work**.

The audit list of "code I could still ship" is now empty. Everything
short of human-and-account-required work is in the repo.
