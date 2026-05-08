# Browser Extension E2E (Playwright)

Drives a real Chromium with the built MV3 extension loaded, navigates to a
fixture EHR page, and verifies the content-script extraction contract.

## Why a separate suite

Unit tests in `src/__tests__/*` cover the pure functions (regexes, extractor,
storage shim) under jsdom. They can't validate that:

- The MV3 service worker actually registers in a real Chromium runtime.
- The content script's permissions + matches glob actually inject on
  `https://*/*`.
- The persistent context survives a page reload (sidebar state).

Playwright covers those.

## Run

```bash
cd browser-extension
npm install
npm run build                        # produces dist/
npx playwright install chromium      # one-time browser download
npm run test:e2e
```

## Why not `--headless=new`

Chromium prior to 121 dropped MV3 service workers on a soft-headless launch.
We pin `headless: false` and rely on CI's xvfb. Once Chrome 124+ is the
floor, switch back to headless.

## What's covered

| Test | Asserts |
|---|---|
| `content script extracts CPT + HCPCS from a fixture EHR page` | All 5 codes on the fixture (99497, 99498, 99453, 99454, G0318) are picked up; 4-digit year 2026 is not. |
| `manifest is loadable and service worker registers` | The persistent context boots with the extension mounted. |

## What's deliberately NOT covered (yet)

- Sidebar UI rendering — driven by HTMLImports + needs a stub backend.
- Background script `chrome.runtime.sendMessage` round-trips — same.

Both are tracked for Phase 10 once the stub-backend harness lands.
