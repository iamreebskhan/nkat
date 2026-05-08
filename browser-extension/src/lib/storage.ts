/**
 * Typed wrapper around chrome.storage.sync for the extension's saved
 * options. The chrome.* API is mocked in tests via test/setup.ts.
 */

export interface ExtensionOptions {
  backendUrl: string;
  orgId: string;
  userId?: string;
  defaultState?: string;
}

const DEFAULTS: ExtensionOptions = {
  backendUrl: 'http://localhost:3000',
  orgId: '',
};

export async function loadOptions(): Promise<ExtensionOptions> {
  const stored = await chrome.storage.sync.get(['backendUrl', 'orgId', 'userId', 'defaultState']);
  return {
    ...DEFAULTS,
    ...stored,
  };
}

export async function saveOptions(opts: ExtensionOptions): Promise<void> {
  await chrome.storage.sync.set(opts);
}
