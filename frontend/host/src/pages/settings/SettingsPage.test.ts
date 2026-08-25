import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {defineMndwUi} from '@mndw/ui';
import {mount as mountComponent, unmount} from 'svelte';
import {MNDW_TOKENS} from '@mndw/sdk';

const {
  downloadDiagnostics,
  getCapability,
  navigate,
  probeControllerTokenAuth,
  routerPathname,
  saveController,
} = vi.hoisted(() => ({
  downloadDiagnostics: vi.fn(),
  getCapability: vi.fn().mockResolvedValue({
    store: {state: 'empty'},
    controller: {support: 'unknown'},
    extenders: [],
    stale: false,
  }),
  navigate: vi.fn().mockResolvedValue(undefined),
  probeControllerTokenAuth: vi.fn().mockResolvedValue(true),
  routerPathname: {pathname: '/settings/general'},
  saveController: vi.fn(),
}));

vi.mock('../../router/create-app-router.js', () => ({
  appRouter: {
    route: routerPathname,
    navigate,
  },
}));

vi.mock('../../services/mgmt-client.js', () => ({
  mgmtClient: {
    listPlugins: vi.fn().mockResolvedValue([]),
    uploadPlugin: vi.fn(),
    approvePlugin: vi.fn(),
    enablePlugin: vi.fn(),
    disablePlugin: vi.fn(),
    setPluginPermission: vi.fn(),
    denyPlugin: vi.fn(),
    deletePlugin: vi.fn(),
  },
  messageForError: vi.fn(),
}));
// Partial: `app.svelte.ts` reads `getTheme()` from this module at import time.
vi.mock('../../services/theme.service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/theme.service.js')>(),
  toggleTheme: vi.fn(),
}));
vi.mock('../../services/palette.service.js', () => ({
  refreshPalette: vi.fn().mockResolvedValue(undefined),
  previewOverride: vi.fn(),
  discardPreview: vi.fn(),
  commitOverride: vi.fn().mockResolvedValue(undefined),
  resetToDefault: vi.fn().mockResolvedValue(undefined),
  getExportable: vi.fn(() => MNDW_TOKENS),
  getApplied: vi.fn(() => null),
  paletteService: {
    refreshPalette: vi.fn().mockResolvedValue(undefined),
    previewOverride: vi.fn(),
    discardPreview: vi.fn(),
    commitOverride: vi.fn().mockResolvedValue(undefined),
    resetToDefault: vi.fn().mockResolvedValue(undefined),
    getExportable: vi.fn(() => MNDW_TOKENS),
  },
}));
vi.mock('../../services/persistent-rci-session.service.js', () => ({
  persistentRciSessionService: {
    getCapability,
    probeControllerTokenAuth,
    testController: vi.fn(),
    saveController,
    clearController: vi.fn(),
  },
}));
vi.mock('../../services/diagnostics.service.js', () => ({downloadDiagnostics}));

import SettingsPage from './SettingsPage.svelte';
import generalSettingsSource from './GeneralSettings.svelte?raw';
import {toggleTheme} from '../../services/theme.service.js';
import {defaultHostServices} from '../../host-services.js';
import {createHostServicesContext} from '../../host-services-context.js';

const mount = (component: typeof SettingsPage, options: {target: HTMLElement}) =>
  mountComponent(component, {...options, context: createHostServicesContext(defaultHostServices())});

beforeAll(() => {
  defineMndwUi();
});

describe('SettingsPage', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.mocked(toggleTheme).mockClear();
    getCapability.mockReset().mockResolvedValue({
      store: {state: 'empty'},
      controller: {support: 'unknown'},
      extenders: [],
      stale: false,
    });
    probeControllerTokenAuth.mockReset().mockResolvedValue(true);
    saveController.mockReset();
    downloadDiagnostics.mockReset();
    navigate.mockReset().mockResolvedValue(undefined);
    routerPathname.pathname = '/settings/general';
  });

  it('renders route-backed tabs and keeps General selected by default', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});
    const tabs = target.querySelector<HTMLElement & {updateComplete: Promise<unknown>}>('mndw-tabs');

    await tabs?.updateComplete;
    await vi.waitFor(() =>
      expect(target.querySelector('mndw-tab#general')?.getAttribute('aria-selected'))
        .toBe('true')
    );

    expect([...target.querySelectorAll('mndw-tab')].map((tab) => tab.id)).toEqual([
      'general',
      'diagnostics',
      'plugins',
    ]);
    expect([...target.querySelectorAll('mndw-tab-panel')].map((panel) => panel.getAttribute('for'))).toEqual([
      'general',
      'diagnostics',
      'plugins',
    ]);
    expect(target.querySelector('mndw-tab#diagnostics')?.getAttribute('aria-selected')).toBe('false');
    expect(target.querySelector('mndw-tab#plugins')?.getAttribute('aria-selected')).toBe('false');

    void unmount(component);
  });

  it('navigates to selected child route', () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    target.querySelector('mndw-tabs')?.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value: 'diagnostics'},
      }),
    );

    expect(navigate).toHaveBeenCalledWith('/settings/diagnostics');

    void unmount(component);
  });

  it('redirects the settings entry route to General with history replacement', async () => {
    routerPathname.pathname = '/settings';

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/settings/general', {replace: true}));

    void unmount(component);
  });

  it('selects tab from child route', async () => {
    routerPathname.pathname = '/settings/plugins';

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() =>
      expect(target.querySelector('mndw-tab#plugins')?.getAttribute('aria-selected'))
        .toBe('true')
    );
    expect(target.querySelector('mndw-tab#general')?.getAttribute('aria-selected')).toBe('false');

    void unmount(component);
  });

  it('renders plugin manager', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('.mndw-plugin-manager')).not.toBeNull());

    void unmount(component);
  });

  it('offers the theme switch through a labelled field', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});
    const control = target.querySelector('mndw-switch');
    const field = target.querySelector<HTMLElement & {label: string; updateComplete: Promise<unknown>}>('mndw-field');

    await field?.updateComplete;

    const label = field?.querySelector<HTMLLabelElement>('label.mndw-field__label');

    // A switch, not a checkbox: the theme change applies immediately.
    expect(target.querySelector('input[type="checkbox"]')).toBeNull();
    expect(control?.id).toBe('mndw-theme-switch');
    expect(field?.label).toContain('Dark theme');
    expect(label?.textContent?.trim()).toContain('Dark theme');

    void unmount(component);
  });

  it('leaves General Settings field layout to shared CSS', () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    expect(generalSettingsSource).toMatch(/\.mndw-general-settings mndw-field\s*\{\s*margin:\s*0\.75rem 0;/u);
    expect(generalSettingsSource).not.toMatch(
      /\.mndw-general-settings mndw-field\s*\{[^}]*\b(?:display|flex-direction|gap):/u,
    );

    void unmount(component);
  });

  it('toggles the theme from the switch change event', () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});
    const control = target.querySelector('mndw-switch');

    expect(toggleTheme).not.toHaveBeenCalled();

    control?.dispatchEvent(new CustomEvent('mndwchange', {bubbles: true, composed: true, detail: {checked: true}}));

    expect(toggleTheme).toHaveBeenCalledTimes(1);

    void unmount(component);
  });

  it('renders the palette manager between Appearance and Device', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Persistent rci session"]')).not.toBeNull());

    const headings = [...target.querySelectorAll('h3')].map((heading) => heading.textContent?.trim());

    expect(headings.slice(0, 3)).toEqual(['Appearance', 'Palette', 'Device']);
    expect(target.querySelector('.mndw-palette-manager')).not.toBeNull();
    expect(target.querySelector('.mndw-plugin-manager')).not.toBeNull();

    void unmount(component);
  });

  it('hides persistent-session settings when controller token probe is not found', async () => {
    probeControllerTokenAuth.mockResolvedValueOnce(false);

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Persistent rci session"]')).toBeNull());
    expect(target.querySelector('section[aria-label="Persistent rci session"]')).toBeNull();
    expect(target.querySelector('section[aria-label="Extender access"]')).toBeNull();

    void unmount(component);
  });

  it('shows a placeholder instead of the saved controller token', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Persistent rci session"]')).not.toBeNull());
    target.querySelector<HTMLElement>('#mndw-persistent-rci-enabled')?.dispatchEvent(
      new CustomEvent('mndwchange', {bubbles: true, composed: true, detail: {checked: true}}),
    );
    await vi.waitFor(() => expect(target.querySelector('mndw-input[type="password"]')).not.toBeNull());

    const tokenInput = target.querySelector<HTMLElement>('mndw-input[type="password"]');

    tokenInput?.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value: 'secret'}}));
    saveController.mockResolvedValueOnce({result: 'valid'});
    getCapability.mockResolvedValueOnce({
      store: {state: 'empty'},
      controller: {support: 'supported'},
      extenders: [],
      stale: false,
    });
    target.querySelector('mndw-button[variant="primary"]')?.dispatchEvent(new Event('click', {bubbles: true}));

    await vi.waitFor(() => expect(saveController).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(target.querySelector('mndw-input[type="password"]')?.getAttribute('placeholder')).toBe('<TOKEN SET>')
    );

    void unmount(component);
  });

  it('shows diagnostics regardless of persistent-session capability', async () => {
    probeControllerTokenAuth.mockResolvedValueOnce(false);

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Diagnostics"]')).not.toBeNull());
    expect(target.querySelector('section[aria-label="Diagnostics"]')).not.toBeNull();
    expect(target.querySelector('section[aria-label="Diagnostics"]')?.textContent).toContain('Download diagnostics');

    void unmount(component);
  });

  it('disables diagnostics while downloading and reports stable failure text', async () => {
    let resolveDownload: (() => void) | undefined;

    downloadDiagnostics.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDownload = resolve;
      }),
    );

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});
    const button = await vi.waitFor(() => {
      const value = target.querySelector<HTMLElement>('section[aria-label="Diagnostics"] mndw-button');

      if (value === null) {
        throw new Error('diagnostics button not rendered');
      }

      return value;
    });

    button.dispatchEvent(new Event('click', {bubbles: true}));
    await vi.waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    resolveDownload?.();
    await vi.waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));

    downloadDiagnostics.mockRejectedValueOnce(new Error('DO_NOT_EXPORT'));
    button.dispatchEvent(new Event('click', {bubbles: true}));
    await vi.waitFor(() => expect(target.textContent).toContain('Diagnostics download failed'));
    expect(target.textContent).not.toContain('DO_NOT_EXPORT');

    void unmount(component);
  });
});
