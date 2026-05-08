/**
 * Sidebar entry — vanilla TS DOM rendering of pre-flight findings.
 * Most of the meat is in the testable `renderFindings` pure function;
 * this module wires that to chrome.tabs + ApiClient and the static HTML.
 */
import { ApiClient, type LookupResponse } from './lib/api-client';
import type { ExtractedCode } from './lib/code-extractor';
import { loadOptions } from './lib/storage';
import { renderFindings, renderDetectedCodes, todayIso } from './lib/sidebar-render';

async function getActiveTabCodes(): Promise<{ codes: ExtractedCode[]; tab: chrome.tabs.Tab | null }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { codes: [], tab: null };
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id!, { type: 'EXTRACT_CODES' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        resolve({ codes: [], tab });
        return;
      }
      resolve({ codes: resp.codes ?? [], tab });
    });
  });
}

async function bootstrap() {
  const opts = await loadOptions();
  const stateInput = document.getElementById('state') as HTMLInputElement;
  const payerInput = document.getElementById('payer-id') as HTMLInputElement;
  const productLineSelect = document.getElementById('product-line') as HTMLSelectElement;
  const dosInput = document.getElementById('dos') as HTMLInputElement;
  const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
  const detectedList = document.getElementById('detected-codes') as HTMLUListElement;
  const findingsList = document.getElementById('findings-list') as HTMLOListElement;
  const status = document.getElementById('status') as HTMLParagraphElement;
  const footer = document.getElementById('footer-info') as HTMLElement;

  if (opts.defaultState) stateInput.value = opts.defaultState;
  dosInput.value = todayIso();

  refreshBtn.addEventListener('click', async () => {
    status.textContent = 'Scanning the active tab…';
    findingsList.innerHTML = '';

    if (!opts.orgId) {
      status.textContent = 'Open Options and set Org ID before running pre-flight.';
      return;
    }

    const { codes } = await getActiveTabCodes();
    detectedList.innerHTML = '';
    if (codes.length === 0) {
      status.textContent = 'No CPT/HCPCS codes detected on this page.';
      return;
    }
    renderDetectedCodes(detectedList, codes);

    const payerId = payerInput.value.trim();
    if (!payerId) {
      status.textContent = 'Set Payer ID before running pre-flight.';
      return;
    }
    status.textContent = 'Running pre-flight…';

    const client = new ApiClient({
      baseUrl: opts.backendUrl,
      orgId: opts.orgId,
      ...(opts.userId ? { userId: opts.userId } : {}),
    });
    try {
      const resp: LookupResponse = await client.lookup({
        payer_id: payerId,
        state: stateInput.value.trim().toUpperCase(),
        product_line: productLineSelect.value,
        date_of_service: dosInput.value,
        lines: codes.map((c) => ({ code: c.code })),
      });
      status.textContent = resp.summary;
      renderFindings(findingsList, resp);
      footer.textContent = `Request ${resp.request_id.slice(0, 8)} · ${codes.length} codes scanned`;
    } catch (e) {
      status.textContent = `Pre-flight failed: ${(e as Error).message}`;
    }
  });
}

void bootstrap();
