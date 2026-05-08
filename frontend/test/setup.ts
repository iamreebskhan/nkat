import '@testing-library/jest-dom';

// jsdom doesn't define matchMedia; some components consult prefers-color-scheme.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      addListener: () => {},
      removeListener: () => {},
    }),
  });
}

// localStorage clean slate per test. Some test files don't get jsdom's
// localStorage hooked into globalThis until later in setup; guard so the
// before-each doesn't throw on those.
beforeEach(() => {
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      globalThis.localStorage.clear();
    }
  } catch { /* tolerate */ }
});
