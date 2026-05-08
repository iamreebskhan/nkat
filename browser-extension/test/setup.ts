// Minimal chrome.* mock for jsdom-based extension tests.
// We only stub the surface our code actually touches; everything else throws.
type Listener = (msg: unknown, sender?: unknown, sendResponse?: (r?: unknown) => void) => void | boolean | Promise<unknown>;

const listeners: Listener[] = [];

(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    sync: {
      get: jest.fn(),
      set: jest.fn(),
    },
  },
  runtime: {
    sendMessage: jest.fn(),
    onMessage: {
      addListener: (cb: Listener) => { listeners.push(cb); },
      removeListener: (cb: Listener) => { listeners.splice(listeners.indexOf(cb), 1); },
    },
    getURL: (path: string) => `chrome-extension://test/${path}`,
    id: 'test-extension',
  },
  sidePanel: {
    open: jest.fn(),
    setOptions: jest.fn(),
    setPanelBehavior: jest.fn(),
  },
  tabs: {
    query: jest.fn(),
    sendMessage: jest.fn(),
  },
  action: {
    onClicked: { addListener: jest.fn() },
  },
};

// Helper for tests that want to drive incoming messages.
(globalThis as { __dispatchChromeMessage?: (msg: unknown) => void }).__dispatchChromeMessage = (msg: unknown) => {
  for (const l of listeners) l(msg);
};
