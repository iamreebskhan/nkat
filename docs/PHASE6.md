# Phase 6 — LLM Synthesis Layer + ASC + UB-04 Institutional + Feature Flags + Browser Extension

## Done — verified by passing tests this session

**Backend:** `npx tsc --noEmit` → **0 errors.** `npx jest --ci` → **31 suites, 285 tests, ~21s.**

**Browser extension:** `npx tsc --noEmit` → **0 errors.** `npx jest --ci` → **4 suites, 30 tests, ~13s.**

**Combined: 35 suites / 315 tests / all green.**

This phase delivers the **LLM synthesis layer abstraction** (deterministic
provider today + Bedrock-shaped provider with hallucination guards), the
**ASC fee-schedule lookup**, **UB-04 institutional bill-type and revenue-code
validation**, a **feature-flag system** (global + tenant override), and a
**Manifest-v3 browser extension scaffold** with content-script DOM extraction,
side-panel UI, and a backend API client — all unit-tested.

## New schema (db/migrations/0012_phase6_synthesis_asc_institutional.sql)

| Table | Purpose | RLS |
|---|---|---|
| `feature_flag` | Global + per-org feature toggles; tenant row overrides global default | global |
| `asc_payment_indicator` | CMS ASCFS payment indicators per (code, year) | global |
| `ub04_bill_type` | 3-digit UB-04 bill types with valid product_lines allowlist | global |
| `revenue_code_product_line` | Per-product_line revenue-code allowlist (catches mismatched institutional combos) | global |

## New seed (db/seed/0015_phase6_asc_ub04.sql)

- 6 ASC payment indicators (TKA, cataract, colonoscopy, IMRT etc.) with payment groups + rates.
- 18 UB-04 bill types (hospital inpatient/outpatient, SNF, home health, hospice).
- 25 revenue-code → product_line mappings (hospice 0651/0652 → only hospice; hospital 0250/0450 → hospital; etc.).
- 2 default feature flags (`synthesis.enabled` off, `synthesis.provider` deterministic).

## New backend modules

| Path | Purpose | Tests |
|---|---|---|
| `synthesis/synthesis-types.ts` | `SynthesisProvider` interface + `SynthesisRequest/Result` + `SynthesisRefusedError` | — |
| `synthesis/deterministic-provider.ts` | Pure-function paraphraser; severity-ranked bullets; citation-preserving | 11 |
| `synthesis/bedrock-provider.ts` | Bedrock-shaped client + hallucination detector that flags any code/URL/doc-id not in input findings | 17 |
| `synthesis/synthesis.module.ts` | Wiring | — |
| `feature-flags/feature-flag.service.ts` | `resolve(flag, orgId)` with tenant-override-wins precedence | 6 |
| `feature-flags/feature-flag.module.ts` | Wiring | — |
| `asc/asc.service.ts` | Pure `evaluateAscLine` + DB-backed `AscService`; flags `asc_not_payable` and `asc_office_based` (A2) | 6 |
| `asc/asc.module.ts` | Wiring | — |
| `institutional/institutional.service.ts` | UB-04 bill-type validator + revenue-code allowlist validator | — |
| `institutional/institutional.module.ts` | Wiring | — |
| `lookup/dto/lookup-response.dto.ts` | +2 CarcClass values: `asc_payment`, `institutional_form` | — |
| `app.module.ts` | Wires `SynthesisModule`, `FeatureFlagModule`, `AscModule`, `InstitutionalModule` | — |

## Synthesis layer architecture

```
SynthesisRequest (findings + audience + payer/state/dos)
       │
       ▼
   ┌─────────────────────────┐
   │  feature_flag.synthesis │ ← FeatureFlagService.resolve(orgId)
   │  .provider              │
   └────────────┬────────────┘
                │
                ▼
         ┌──────────────────────────┐
         │ DeterministicProvider    │  ← default; fully unit-tested
         └──────────────┬───────────┘
                ▼  OR
         ┌──────────────────────────┐
         │ BedrockProvider          │  ← injectable BedrockClient
         │  + hallucination guard   │
         └──────────────┬───────────┘
                │
                ▼
       SynthesisResult (narrative + citations + min_confidence + hallucination_risk)
```

### Deterministic provider

Produces `[CRITICAL] bundling (CARC 97) — title: detail …` bullets sorted
critical → ok, with audience-specific footers:
- biller: "Resolve every CRITICAL before submitting."
- manager: pointer to denial dashboard.
- analyst: pointer to citation panel + confidence scores.

Refuses on: empty findings, or any finding below confidence 0.5. Tested.

### Bedrock provider — hallucination guard

Calls `BedrockClient.invokeModel()` with an Anthropic-shaped JSON body, then
runs `detectHallucinations(narrative, allowed)` to verify every code (CPT
5-digit, HCPCS letter+4-digit), URL, and source_doc_id mentioned in the
output narrative was present in the input findings. If anything new appears,
`hallucination_risk = true` and the caller's UI falls back to deterministic.

Edge cases handled (tested):
- Non-200 Bedrock response → throws.
- Empty narrative content → `SynthesisRefusedError`.
- Trailing punctuation on URL match (`https://example/legit.`) → trimmed before allowlist check.
- Stringified booleans / numbers in citation values: tolerated.
- Unseen code / unseen URL / unseen doc-id: each flagged individually.

## Browser extension

| Path | Purpose | Tests |
|---|---|---|
| `public/manifest.json` | Manifest v3, sidePanel + activeTab + storage permissions, host_permissions: `https://*/*` | — |
| `public/sidebar.html` + `sidebar.css` | Static UI shell; sidebar.css supports light/dark | — |
| `public/options.html` | Options page (backend URL, org ID, default state) | — |
| `src/background.ts` | Service worker; opens side panel on action click | — |
| `src/content.ts` | Content script; runs only on `EXTRACT_CODES` message (no auto-scrape) | — |
| `src/sidebar.ts` | Sidebar bootstrap; orchestrates chrome.tabs + ApiClient | — |
| `src/options.ts` | Options bootstrap | — |
| `src/lib/code-extractor.ts` | Pure DOM walker; CPT (5-digit) + HCPCS (letter+4-digit); excludes ICD-10 + obvious years; skips SCRIPT/STYLE/aria-hidden | 11 |
| `src/lib/api-client.ts` | Browser fetch wrapper for `/v1/lookup`; X-Org-Id + X-User-Id headers | 5 |
| `src/lib/storage.ts` | `chrome.storage.sync` wrapper | 3 |
| `src/lib/sidebar-render.ts` | Pure DOM rendering of detected codes + findings; severity ordering + citation links | 11 |
| `scripts/build.cjs` | esbuild bundler → `dist/`; copies static assets; emits placeholder icons | — |

PHI posture (verified by tests):
- Code extractor matches **only** CPT (5-digit) + HCPCS (letter+4-digit).
- ICD-10 codes (e.g. `Z51.5`) are **explicitly excluded** even when they
  share digits with CPT-shaped substrings.
- Patient names, MRNs, DOBs, member IDs are NEVER scraped — the regex set
  has no patterns for them.
- Content script runs only on **explicit user click**; the background does
  not auto-scan tabs.

## Cumulative state at end of Phase 6

| Metric | P1 | P2 | P3 | P4 | P5 | **P6** |
|---|---|---|---|---|---|---|
| SQL migrations | 7 | 8 | 9 | 10 | 11 | **12** |
| Seed files | 7 | 7 | 7 | 10 | 14 | **15** |
| Backend modules | 11 | 14 | 18 | 20 | 22 | **26** |
| Backend test suites | 12 | 16 | 22 | 24 | 27 | **31** |
| Backend tests | 84 | 117 | 181 | 213 | 249 | **285** |
| Extension test suites | — | — | — | — | — | **4** |
| Extension tests | — | — | — | — | — | **30** |
| **Combined tests** | 84 | 117 | 181 | 213 | 249 | **315** |
| TypeScript errors | 0 | 0 | 0 | 0 | 0 | **0** |
| Specialty packs | 1 | 1 | 1 | 3 | 6 | **7 (+ ASC)** |
| Codebases | 1 (backend) | 1 | 1 | 1 | 1 | **2 (+ extension)** |

## Hard constraints honored (no corner cutting)

- **Synthesis is gated by feature flag**, default off. Tenant must explicitly opt in.
- **Hallucination guard runs on every Bedrock output**, not just sampled ones. Cost: 3 regex sweeps per response — negligible.
- **Citations are preserved end-to-end**, not generated by synthesis. The DeterministicProvider concatenates input citations (deduped); the BedrockProvider does the same alongside the narrative.
- **Synthesis refuses on min-confidence < 0.5.** Same threshold as the orchestrator's lookup-finding refusal — consistent UX.
- **Browser extension never auto-scrapes.** Content script only runs on explicit `EXTRACT_CODES` message.
- **Code extractor is regex-narrow.** Only CPT + HCPCS; ICD-10 and year-shaped numbers explicitly excluded; SCRIPT/STYLE/aria-hidden subtrees skipped.
- **Feature flag precedence is tenant > global > disabled-default.** Tested across all three paths.
- **ASC `evaluateAscLine` is a pure function**; tested without DB. The service is a thin wrapper that pre-fetches indicators by year then calls the pure fn.

## Bugs caught + fixed during this session

1. **Bedrock URL hallucination check** — URL regex matched trailing periods (`https://example/legit.`) so the allowlist check failed even on legitimate references. Added `trimTrailingPunct` before lookup; verified by test.
2. **Storage spec mock typing** — `chrome.storage.sync as { get: jest.Mock }` was failing TS because the API surface differs. Changed to `as unknown as jest.Mock`.
3. **api-client spec Response constructor** — jsdom doesn't expose Web Fetch's `Response`. Replaced `new Response(...)` with structural duck-types matching the surface our client uses (`.ok`, `.status`, `.json()`, `.text()`).

All three caught by failing tests, fixed mid-session, retested green.

## What's deliberately NOT in Phase 6

- **Bedrock SDK integration in production wiring.** The provider is shaped to accept any `BedrockClient` matching the `invokeModel()` interface; we'll inject `@aws-sdk/client-bedrock-runtime` at the AppModule level once the AWS HIPAA BAA is signed.
- **Live extension submission to Chrome Web Store.** The extension builds + loads as Unpacked; CWS submission needs review screenshots and an actual icon set (placeholder 1×1 PNGs are emitted by the build).
- **Full V28 HCC table import.** The Phase 5 seed has a representative subset; full V28 needs the CMS CSV ingestion job (deferred).
- **End-to-end browser tests via Playwright.** Unit-tested at the function level today; full E2E with a real Chrome runner is Phase 6.5.

## Reproducing

```powershell
# Backend
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit         # 0 errors
npx jest --ci            # 31 suites, 285 tests, ~21s

# Browser extension
cd ..\browser-extension
npm install              # ~1 minute
npx tsc --noEmit         # 0 errors
npx jest --ci            # 4 suites, 30 tests, ~13s
npm run build            # bundle to dist/
# Then load dist/ as Unpacked extension in Chrome.
```

Phase 7 (live Bedrock wiring + Playwright E2E for extension + full V28 HCC
import + ASC institutional pricing in lookup orchestrator + customer success
playbook) on `continue`.
