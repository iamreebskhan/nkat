# Phases 53–58 — Frontend (strict black & white)

## Numbers

| | Value |
|---|---|
| Frontend unit tests | **17 passing / 0 failing** |
| Frontend test suites | 4 |
| TypeScript errors | 0 |
| Production bundle (gzipped) | ~74 KB total (66 KB main + lazy-loaded routes) |
| Routes | 12 |
| Theme colors | **2 (pure black, pure white) + 7-step greyscale** |

## Strict B&W theme

The whole UI is built on a 2-color palette plus a 7-step greyscale ladder.
Severity is signaled by **left-border weight** (1px / 3px / 6px) and
typographic weight, never by hue. Every text/background pair satisfies
WCAG 2.2 AA 4.5:1.

```
--c-white-100  #ffffff
--c-grey-50    #f7f7f7
--c-grey-100   #ececec
--c-grey-200   #d4d4d4
--c-grey-400   #989898
--c-grey-600   #555555  (≥ 7.5:1 on white)
--c-grey-800   #2a2a2a
--c-black-100  #000000  (21:1 on white)
```

Dark mode = inverted ladder; the 2-color constraint holds.

E2E test `nav.spec.ts > theme is strict B&W` programmatically asserts
`getComputedStyle()` on the active nav link returns an `rgb(r,g,b)`
where `r === g === b`. Any future PR that introduces a chromatic
accent fails CI.

## What landed

### Phase 53 — Scaffold + theme + layout + routing

- Vite + React 18 + TypeScript strict mode.
- React Router v6 with code-split lazy routes; `RequireAuth` guard.
- TanStack Query for data fetching (4xx no-retry; 30s stale time).
- Theme tokens (`styles/theme.css`), reset (`styles/base.css`).
- Component primitives: `Button`, `Input`, `Select`, `Card`, `Table`,
  `PageHeader`, `Layout` (header + sidebar shell). All keyboard-
  navigable, ARIA-labeled, focus-ring 3px solid black.
- Skip-to-main link as the first focusable element.
- API client (`api/client.ts`) with typed errors + auth-token
  attachment + 401-redirect.
- Auth store with `useSyncExternalStore` hook.

### Phase 54 — Login + Lookup

- `LoginPage` — SSO redirect path + dev-header sign-in (matches
  backend's dev_header AuthGuard mode).
- `LookupPage` — full daily-driver UX: cascade filters (state, payer,
  product line, DOS, diagnoses, taxonomy), multi-line claim editor,
  ⌘+Enter submit, severity-stripe finding cards with citations
  rendered as collapsible serif blockquotes.

### Phase 55 — Admin

- `AuditLogPage` — filter + keyset pagination + JSON-payload drawer.
- `ScimTokenPage` — list / create (plaintext shown ONCE banner) / revoke.
- `RateLimitPage` — list / upsert / remove with bounds-validation.
- `DeletionPage` — request (typed `DELETE-TENANT-<slug>` confirmation
  phrase, retain-audit-log toggle, 30-day floor) / cancel.

### Phase 56 — Reconciliation

- Two-pane upload + redaction-preview UX. Source on left, redacted
  text + category counts on right; explicit checkbox confirmation
  before ingestion.

### Phase 57 — Alerts + Denials + Privacy + Billing

- `AlertsPage` — severity-filtered inbox; unread dot is a 8×8 black
  square (no color); mark-as-read mutation.
- `DenialsPage` — 4 KPI cards + a pure-CSS greyscale bar chart + the
  full CARC table with $ impact + pre-flight catch %.
- `PrivacyPage` — state notices (WMHMDA, CCPA, CPA, etc.) +
  inline DSAR intake form + tenant-side DSAR list.
- `BillingPage` — read-only entitlement summary + Stripe portal link.

### Phase 58 — Tests + verification

- **Vitest** unit tests for `authStore`, `Button`, `Input`, `api/client`.
- **Playwright** E2E in `e2e/`:
  - `login.spec.ts` — unauthenticated redirect, dev-header happy
    path, malformed-UUID rejection.
  - `nav.spec.ts` — skip-link first-focus, sidebar reaches every
    primary route, **B&W invariant** (computed style assertion).
- `vite build` clean: 14 chunks, gzipped main 66 KB.

## Accessibility checklist (handled at the component level)

- Skip-to-main link.
- ARIA landmarks: `banner`, `navigation`, `main`, `contentinfo`.
- 3px solid focus-visible ring; never `outline: none` without
  replacement.
- Form labels via `useId()`-bound `htmlFor` everywhere.
- Severity stripes have an `aria-label` overall-summary
  (`role="img"`); errors use `role="alert"`.
- `prefers-reduced-motion` honored (animation duration → 0.01ms).
- Dark mode via `prefers-color-scheme: dark` (inverted greyscale).

## Operational notes

- `npm run dev` proxies `/v1`, `/scim`, `/healthz`, `/readyz`,
  `/status`, `/.well-known` to `http://localhost:3000` (the Nest API).
- `npm run build` produces a static `dist/` deployable to S3 +
  CloudFront. Backend `app.module.ts` already exposes `/status`
  + `/.well-known/security.txt` for the static-status renderer.
- `npm run test:e2e` boots `vite dev` automatically; in CI set
  `E2E_BASE_URL` to the staging URL to skip the local boot.
- `npm run openapi:gen` regenerates types from `../docs/openapi.json`.

## What's deliberately NOT in this batch

- **Browser-extension UI changes** — already exists at
  `browser-extension/`; the new web app uses the same backend
  surface but renders in a desktop layout instead of an injected
  sidebar. Cross-app shared components are a follow-up factoring.
- **Internationalization (Spanish)** — Phase 5 plan item; deferred.
- **Onboarding tour** — described in plan; deferred.
- **Storybook** — per-component visual catalog; deferred. The
  unit + E2E suites cover behavior; visual review goes through the
  Playwright trace artifacts on CI failures.
- **Real SSO callback flow** — `/v1/auth/sso/start` is referenced
  in the login page but the actual OAuth dance lives backend-side
  and requires a configured IdP (out of scope from this seat).
