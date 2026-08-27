// Side-effecting vitest `setupFiles` module. DEFINE ONLY — no observer stubs
// (the 9 web-component setups are defineMndwUi()-only today). The Element guard
// prevents importing the UI barrel in DOM-less (node) environments.
if (typeof Element !== 'undefined') {
  const {defineMndwTestComponents} = await import('./index.js');

  defineMndwTestComponents();
}

export {};
