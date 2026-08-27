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

  it('starts mobile drawer closed without setting desktop collapse intent', async () => {
    const {appState} = await loadAppState(true);

    expect(appState.mobileSidebarOpen).toBe(false);
    expect(appState.desktopSidebarCollapsed).toBe(false);
  });

  it('starts desktop sidebar open and mobile drawer closed on desktop', async () => {
    const {appState} = await loadAppState(false);

    expect(appState.mobileSidebarOpen).toBe(false);
    expect(appState.desktopSidebarCollapsed).toBe(false);
  });

  it('toggles mobile drawer state independently from desktop collapse intent', async () => {
    const {appState, toggleSidebar} = await loadAppState(true);

    toggleSidebar();

    expect(appState.mobileSidebarOpen).toBe(true);
    expect(appState.desktopSidebarCollapsed).toBe(false);
  });

  it('toggles desktop collapse intent without changing mobile drawer state', async () => {
    const {appState, toggleSidebar} = await loadAppState(false);

    toggleSidebar();

    expect(appState.mobileSidebarOpen).toBe(false);
    expect(appState.desktopSidebarCollapsed).toBe(true);
  });
});
