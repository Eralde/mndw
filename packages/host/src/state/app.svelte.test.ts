import {afterEach, describe, expect, it, vi} from 'vitest';

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

async function loadAppState(matches: boolean): Promise<typeof import('./app.svelte.js')> {
  vi.resetModules();

  const matchMedia = vi.fn(() => ({matches, media: '(max-width: 720px)'}));

  vi.stubGlobal('matchMedia', matchMedia);
  Object.defineProperty(window, 'matchMedia', {configurable: true, value: matchMedia});

  return import('./app.svelte.js');
}

describe('app state mobile default', () => {
  afterEach(() => {
    vi.unstubAllGlobals();

    if (originalMatchMedia === undefined) {
      Reflect.deleteProperty(window, 'matchMedia');
    } else {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    }
  });

  it('starts sidebar collapsed when imported on mobile', async () => {
    const {appState} = await loadAppState(true);

    expect(appState.sidebarCollapsed).toBe(true);
  });

  it('starts sidebar open when imported on desktop', async () => {
    const {appState} = await loadAppState(false);

    expect(appState.sidebarCollapsed).toBe(false);
  });
});
