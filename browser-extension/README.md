# billing-rules-extension

Browser extension that overlays the platform's pre-flight findings into any
browser-based EHR. Manifest v3; Chrome/Edge.

## Layout

```
browser-extension/
├── public/
│   ├── manifest.json        Manifest v3
│   ├── sidebar.html         Side panel UI
│   ├── sidebar.css
│   └── options.html         Options page
├── scripts/
│   └── build.cjs            esbuild bundler → dist/
├── src/
│   ├── background.ts        Service worker (opens side panel on toolbar click)
│   ├── content.ts           Content script (runs in EHR page context)
│   ├── sidebar.ts           Sidebar bootstrap + chrome.tabs orchestration
│   ├── options.ts           Options page bootstrap
│   ├── lib/
│   │   ├── code-extractor.ts    Pure-fn DOM walker that finds CPT/HCPCS codes
│   │   ├── api-client.ts        Backend HTTP client (re-creates DTO shape)
│   │   ├── storage.ts           chrome.storage.sync wrapper
│   │   └── sidebar-render.ts    Pure-fn DOM rendering helpers
│   └── __tests__/               jsdom-based unit tests
├── test/
│   └── setup.ts             chrome.* mock for jsdom
├── tsconfig.json
└── package.json
```

## Build + load

```powershell
cd browser-extension
npm install                  # one-time
npm run build                # → dist/
# Then in Chrome: chrome://extensions → Developer mode on →
# Load unpacked → select the dist/ directory.
```

## Test

```powershell
npm run typecheck
npm test
```

## How it works

1. The user opens the side panel from the toolbar action.
2. The user enters their org / payer / state in the sidebar (or sets them once via Options) and clicks **Re-scan**.
3. The sidebar sends an `EXTRACT_CODES` message to the active tab's content script.
4. The content script walks the visible DOM, extracts CPT/HCPCS codes via `code-extractor.ts`, and replies.
5. The sidebar POSTs the codes to the backend's `/v1/lookup` endpoint with `X-Org-Id` and renders findings sorted critical → ok.

## PHI safety posture

- The content script **only runs on explicit user action** (button click); no
  DOM scraping happens automatically.
- Patient identifiers (MRN, member ID, DOB, name) are **never extracted** —
  the regex pack only matches CPT (5-digit) and HCPCS Level II (1 letter +
  4 digits). ICD-10s are detected and explicitly excluded.
- Detected codes + page URL are sent to the backend over HTTPS using the
  user's configured `X-Org-Id`. The user's backend receives only the codes,
  not the surrounding context (snippets are local-only for the sidebar UI).
- All requests are authenticated; the backend's RLS keeps each org's data
  isolated.

## Permissions justification

| Permission | Why |
|---|---|
| `activeTab` | Send `EXTRACT_CODES` to the active tab on user click |
| `storage` | Persist Org ID + backend URL across sessions |
| `sidePanel` | Render the findings UI in Chrome's side panel |
| `scripting` | Reserved for future programmatic content-script injection |
| `host_permissions: https://*/*` | EHRs run on every payer/practice domain; users opt in by clicking the action |
