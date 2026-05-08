/**
 * Content script — runs in the EHR page context. Listens for
 * `EXTRACT_CODES` messages from the sidebar / background and replies with
 * the codes detected on the current page.
 *
 * No PHI ever leaves the page automatically — extraction only runs in
 * response to an explicit message (i.e. after the user clicked Re-scan).
 */
import { extractCodes } from './lib/code-extractor';

interface ExtractCodesRequest {
  type: 'EXTRACT_CODES';
}

interface ExtractCodesResponse {
  type: 'EXTRACT_CODES_RESULT';
  codes: ReturnType<typeof extractCodes>;
  url: string;
  title: string;
}

chrome.runtime.onMessage.addListener(
  (msg: unknown, _sender, sendResponse: (response: ExtractCodesResponse) => void) => {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as ExtractCodesRequest;
    if (m.type !== 'EXTRACT_CODES') return false;
    const codes = extractCodes(document.body);
    sendResponse({
      type: 'EXTRACT_CODES_RESULT',
      codes,
      url: location.href,
      title: document.title,
    });
    return true;
  },
);
