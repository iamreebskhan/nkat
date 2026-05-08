# Phases 59–62 — Frontend ↔ Backend Consistency Audit

User said "make sure that frontend and backend are consistent and fully wired
properly. no cutting corners." This batch runs that audit and closes every
gap surfaced.

## Audit findings (before fixing)

| # | Issue | Severity |
|---|---|---|
| 1 | `GET /v1/alerts` + `PATCH /v1/alerts/:id/read` — frontend calls them, backend has no controller | broken |
| 2 | `GET /v1/denials/summary` — frontend calls it, backend has `/top` `/catch-rate` `/trend` only | broken |
| 3 | Frontend `Alert` shape mismatched `AlertRow` (`type` vs `alert_type`, `read_at` vs `acknowledged_at`, `severity` 3-bucket vs 4-bucket) | broken |
| 4 | `GET /v1/billing/portal-redirect` — frontend used as plain `<a href>`, backend only had `POST /v1/admin/billing/portal-session` | broken |
| 5 | `GET /v1/auth/sso/start` — frontend linked to it, backend had no auth controller | broken |
| 6 | Dev-header auth: frontend minted `Bearer devheader.<orgId>.<userId>.<role>`, backend AuthGuard in dev_header mode expects `X-Org-Id` / `X-User-Id` / `X-Role` headers — every authed request was returning 401 | broken |
| 7 | Frontend `Entitlement.packs` vs backend `specialty_packs`; frontend `trial_ends_at` vs backend `trial_end` | mismatch |

## What landed

### Phase 59 — Backend

- **`AlertsController`** at `/v1/alerts` and `/v1/alerts/:id/read`. Maps
  `AlertRow` → UI-friendly view (title/detail extracted from `payload`,
  severity collapsed from 4-bucket to 3-bucket). PATCH stamps
  `acknowledged_at` + `acknowledged_by`. Filter by severity (3-bucket
  query collapses to internal 4-bucket: `warning` matches `high|medium`)
  + unread.
- **`GET /v1/denials/summary`** — consolidates `topByCarc` + `catchRate`
  into a single response matching the frontend's `DenialResponse` shape
  (period, totals, KPI, buckets[]).
- **`GET /v1/billing/portal-redirect`** — 302 to a freshly minted Stripe
  Customer Portal session URL. Powered by new
  `BillingService.createPortalSessionUrl(orgId)` so the logic is shared
  with the existing admin endpoint.
- **`AuthController`** with three endpoints:
  - `GET /v1/auth/mode` — public, returns `{mode, sso_configured}` so
    the frontend can decide whether to render the SSO button.
  - `GET /v1/auth/sso/start?next=…` — kicks off the OIDC code flow.
    Returns 503 with a clear `SSO_NOT_CONFIGURED` error when
    `OIDC_AUTHORIZATION_URL` + `OIDC_CLIENT_ID` are unset.
  - `GET /v1/auth/me` — returns the calling principal's identity
    claims for FE rehydration after refresh.
- **`Env`** — added `OIDC_AUTHORIZATION_URL`, `OIDC_CLIENT_ID`,
  `OIDC_REDIRECT_URI`, `OIDC_SCOPE`.
- **`Entitlement`** — added `current_period_end` + `trial_end` to the
  service's read shape (sourced from existing `subscription` columns).

### Phase 60 — Frontend

- **`api/client.ts`** — auth-token attachment now branches:
  - `devheader.*` token → set `X-Org-Id` / `X-User-Id` / `X-Role`
    headers (NOT Authorization). Matches backend AuthGuard's
    dev_header mode.
  - Real JWT → `Authorization: Bearer <token>`. Matches AuthGuard's
    jwt mode.
  - Two new unit tests cover both branches.
- **`LoginPage`** — queries `/v1/auth/mode` on mount; renders SSO
  button only when `sso_configured`; renders dev-header form only
  when `mode === 'dev_header'`; renders an explicit error when
  neither is available.
- **`BillingPage`** — entitlement shape matches backend
  (`specialty_packs`, `trial_end`, `status`, `in_grace_period`).

### Phase 61 — Codegen

- **OpenAPI export** regenerated → **71 paths** (up from 64; added 7).
- **Frontend `src/api/schema.ts`** regenerated via
  `openapi-typescript` (2917 lines) — typed contract is now a
  build-time check, not a runtime hope.

## Final verification

| | Result |
|---|---|
| Backend `tsc --noEmit` | clean |
| Backend `jest --ci` | **713 / 713 passing** |
| Backend OpenAPI export | 71 paths |
| Frontend `tsc --noEmit` | clean |
| Frontend `vitest run` | **19 / 19 passing** (was 17; +2 dev-header header tests) |
| Frontend `vite build` | clean — 66 KB gzipped main + lazy chunks |

## Endpoint contract — every frontend call now has a backend match

| Frontend call | Backend route | Guard | Status |
|---|---|---|---|
| `POST /v1/lookup` | `LookupController.run` | AuthGuard + RateLimit | ✓ |
| `POST /v1/redaction/preview` | `RedactionController.preview` | AuthGuard + RateLimit | ✓ |
| `GET /v1/admin/audit-log` | `AuditLogController.search` | AuthGuard | ✓ |
| `GET/POST/DELETE /v1/admin/scim/tokens` | `ScimTokenController` | AuthGuard | ✓ |
| `GET/PUT/DELETE /v1/admin/rate-limit/overrides` | `RateLimitOverrideController` | AuthGuard | ✓ |
| `GET/POST/DELETE /v1/admin/tenant/delete` | `TenantDeletionController` | AuthGuard | ✓ |
| `GET /v1/alerts`, `PATCH /v1/alerts/:id/read` | `AlertsController` | AuthGuard | ✓ NEW |
| `GET /v1/denials/summary` | `DenialController.summary` | AuthGuard | ✓ NEW |
| `GET /v1/privacy/notices/:state` | `PrivacyController.notices` | (public) | ✓ |
| `GET/POST /v1/privacy/dsar`, `POST /v1/privacy/consent`, `PATCH /v1/privacy/dsar/:id` | `PrivacyController` | AuthGuard | ✓ |
| `GET /v1/billing/entitlement` | `BillingController.entitlement` | AuthGuard | ✓ |
| `GET /v1/billing/portal-redirect` | `BillingController.portalRedirect` | AuthGuard | ✓ NEW |
| `GET /v1/auth/mode` | `AuthController.mode` | (public) | ✓ NEW |
| `GET /v1/auth/sso/start` | `AuthController.ssoStart` | (public) | ✓ NEW |
| `GET /v1/auth/me` | `AuthController.me` | AuthGuard | ✓ NEW |

## What I deliberately deferred

- **Real OIDC callback handler** — the SSO start endpoint redirects
  to the IdP, but the `/v1/auth/sso/callback` that exchanges a code
  for a JWT requires a configured IdP + a token-signing key + a
  cookie/session strategy. That's its own phase + needs an account.
- **Visual polish** — page styles still use inline `style={{...}}`
  in a few admin pages. They work and are accessible; a follow-up
  pass to extract to CSS modules would be welcome but the look is
  already brutalist B&W consistent.
- **More E2E coverage** — the existing Playwright suite covers login
  + nav + B&W invariant. Per-page happy paths against a live backend
  is the next E2E layer.

The wires are all real now. Frontend dev mode plus backend
`AUTH_MODE=dev_header` is a fully functional end-to-end stack on
`localhost:5173` ↔ `localhost:3000`.
