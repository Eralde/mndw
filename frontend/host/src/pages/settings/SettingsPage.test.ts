import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {defineMndwUi} from '@mndw/ui';
import {mount as mountComponent, unmount} from 'svelte';
import {MNDW_TOKENS} from '@mndw/sdk';

const {
  downloadDiagnostics,
  getCapability,
  navigate,
  routerPathname,
  saveController,
  setEnabled,
  selfUpdateStatus,
} = vi.hoisted(() => ({
  downloadDiagnostics: vi.fn(),
  getCapability: vi.fn().mockResolvedValue({
    store: {state: 'empty'},
    controller: {support: 'unknown', auth: 'unknown', enabled: false},
    extenders: [],
    stale: false,
  }),
  navigate: vi.fn().mockResolvedValue(undefined),
  routerPathname: {pathname: '/settings/general'},
  saveController: vi.fn(),
  setEnabled: vi.fn().mockResolvedValue(undefined),
  selfUpdateStatus: vi.fn().mockResolvedValue({state: 'idle', version: 'dev'}),
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
vi.mock('../../services/persistent-rci-session.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/persistent-rci-session.service.js')>();

  return {
    ...original,
    persistentRciSessionService: {
      getCapability,
      testController: vi.fn(),
      saveController,
      clearController: vi.fn(),
      setEnabled,
    },
  };
});
vi.mock('../../services/diagnostics.service.js', () => ({downloadDiagnostics}));
vi.mock('../../services/self-update-client.js', () => ({
  selfUpdateClient: {
    status: selfUpdateStatus,
    check: vi.fn(),
    apply: vi.fn(),
    revert: vi.fn(),
  },
}));

import SettingsPage from './SettingsPage.svelte';
import generalSettingsSource from './GeneralSettings.svelte?raw';
import {toggleTheme} from '../../services/theme.service.js';
import {defaultHostServices} from '../../host-services.js';
import {createHostServicesContext} from '../../host-services-context.js';
import {PersistentRciSessionError} from '../../services/persistent-rci-session.service.js';

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
      controller: {support: 'unknown', auth: 'unknown', enabled: false},
      extenders: [],
      stale: false,
    });
    saveController.mockReset();
    setEnabled.mockReset().mockResolvedValue(undefined);
    downloadDiagnostics.mockReset();
    selfUpdateStatus.mockReset().mockResolvedValue({state: 'idle', version: 'dev'});
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
      'self-update',
    ]);
    expect([...target.querySelectorAll('mndw-tab-panel')].map((panel) => panel.getAttribute('for'))).toEqual([
      'general',
      'diagnostics',
      'plugins',
      'self-update',
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

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Persistent RCI session"]')).not.toBeNull());

    const headings = [...target.querySelectorAll('h3')].map((heading) => heading.textContent?.trim());

    expect(headings.slice(0, 3)).toEqual(['Appearance', 'Palette', 'Device']);
    expect(target.querySelector('.mndw-palette-manager')).not.toBeNull();
    expect(target.querySelector('.mndw-plugin-manager')).not.toBeNull();

    void unmount(component);
  });

  it('renders single switch without token field in tokenless mode', async () => {
    getCapability.mockResolvedValueOnce({
      store: {state: 'empty'},
      controller: {support: 'supported', auth: 'none', enabled: true},
      extenders: [],
      stale: false,
    });

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Persistent RCI session"]')).not.toBeNull());

    const control = target.querySelector<HTMLElement & {checked: boolean}>('#mndw-persistent-rci-enabled');

    expect(control?.checked).toBe(true);
    expect(target.querySelector('mndw-input[type="password"]')).toBeNull();
    expect(target.textContent).toContain('Persistent session with controller and extenders');

    void unmount(component);
  });

  it('enables tokenless session via setEnabled and refreshes capability', async () => {
    const disabledCapability = {
      store: {state: 'empty'},
      controller: {support: 'supported', auth: 'none', enabled: false},
      extenders: [],
      stale: false,
    };

    getCapability.mockResolvedValueOnce(disabledCapability).mockResolvedValueOnce({
      ...disabledCapability,
      controller: {...disabledCapability.controller, enabled: true},
    });

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    const control = await vi.waitFor(() => {
      const value = target.querySelector<HTMLElement>('#mndw-persistent-rci-enabled');

      if (value === null) {
        throw new Error('tokenless switch not rendered');
      }

      return value;
    });

    control.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {checked: true},
      }),
    );

    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith(true));
    await vi.waitFor(() => expect(getCapability).toHaveBeenCalledTimes(2));

    void unmount(component);
  });

  it('reverts tokenless switch when enabling fails', async () => {
    const disabledCapability = {
      store: {state: 'empty'},
      controller: {support: 'supported', auth: 'none', enabled: false},
      extenders: [],
      stale: false,
    };

    getCapability.mockResolvedValueOnce(disabledCapability).mockResolvedValueOnce(disabledCapability);
    setEnabled.mockRejectedValueOnce(new PersistentRciSessionError('RCI_DEVICE_UNREACHABLE', 502));

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    const control = await vi.waitFor(() => {
      const value = target.querySelector<HTMLElement>('#mndw-persistent-rci-enabled');

      if (value === null) {
        throw new Error('tokenless switch not rendered');
      }

      return value;
    });

    control.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {checked: true},
      }),
    );

    await vi.waitFor(() => expect(target.textContent).toContain('Device unreachable'));
    await vi.waitFor(() => {
      const current = target.querySelector<HTMLElement & {checked: boolean}>('#mndw-persistent-rci-enabled');

      expect(current?.checked).toBe(false);
    });

    void unmount(component);
  });

  it('shows the operation error when capability refresh also fails', async () => {
    const disabledCapability = {
      store: {state: 'empty'},
      controller: {support: 'supported', auth: 'none', enabled: false},
      extenders: [],
      stale: false,
    };

    getCapability.mockResolvedValueOnce(disabledCapability).mockRejectedValueOnce(new Error('refresh failed'));
    setEnabled.mockRejectedValueOnce(new PersistentRciSessionError('RCI_DEVICE_UNREACHABLE', 502));

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    const control = await vi.waitFor(() => {
      const value = target.querySelector<HTMLElement>('#mndw-persistent-rci-enabled');

      if (value === null) {
        throw new Error('tokenless switch not rendered');
      }

      return value;
    });

    control.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {checked: true},
      }),
    );

    await vi.waitFor(() => {
      expect(target.textContent).toContain('Persistent RCI session state unavailable');
      expect(target.textContent).toContain('Device unreachable');
    });

    void unmount(component);
  });

  it('shows needs-token banner and token field in token mode', async () => {
    getCapability.mockResolvedValueOnce({
      store: {state: 'empty'},
      controller: {support: 'needs-token', auth: 'token', enabled: true},
      extenders: [],
      stale: false,
    });

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() =>
      expect(target.textContent).toContain('Firmware was updated and now requires a controller token.')
    );
    expect(target.querySelector('mndw-input[type="password"]')).not.toBeNull();

    void unmount(component);
  });

  it('shows state unavailable when auth mode is unknown', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Persistent RCI session"]')).not.toBeNull());
    expect(target.querySelector('section[aria-label="Persistent RCI session"]')?.textContent)
      .toContain('Persistent RCI session state unavailable');
    expect(target.querySelector('#mndw-persistent-rci-enabled')).toBeNull();

    void unmount(component);
  });

  it('shows state unavailable when capability request fails', async () => {
    getCapability.mockRejectedValueOnce(new Error('ignored detail'));

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Persistent RCI session"]')).not.toBeNull());
    expect(target.querySelector('section[aria-label="Persistent RCI session"]')?.textContent)
      .toContain('Persistent RCI session state unavailable');
    expect(target.querySelector('#mndw-persistent-rci-enabled')).toBeNull();

    void unmount(component);
  });

  it('shows telemetry section when tokenless session is enabled', async () => {
    getCapability.mockResolvedValueOnce({
      store: {state: 'empty'},
      controller: {support: 'supported', auth: 'none', enabled: true},
      extenders: [],
      stale: false,
    });

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.textContent).toContain('Background telemetry'));

    void unmount(component);
  });

  it('shows a placeholder instead of the saved controller token', async () => {
    getCapability.mockResolvedValueOnce({
      store: {state: 'empty'},
      controller: {support: 'unknown', auth: 'token', enabled: false},
      extenders: [],
      stale: false,
    });

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Persistent RCI session"]')).not.toBeNull());
    target.querySelector<HTMLElement>('#mndw-persistent-rci-enabled')?.dispatchEvent(
      new CustomEvent('mndwchange', {bubbles: true, composed: true, detail: {checked: true}}),
    );
    await vi.waitFor(() => expect(target.querySelector('mndw-input[type="password"]')).not.toBeNull());

    const tokenInput = target.querySelector<HTMLElement>('mndw-input[type="password"]');

    tokenInput?.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value: 'secret'}}));
    saveController.mockResolvedValueOnce({result: 'valid'});
    getCapability.mockResolvedValueOnce({
      store: {state: 'empty'},
      controller: {support: 'supported', auth: 'token', enabled: true},
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
    getCapability.mockResolvedValueOnce({
      store: {state: 'empty'},
      controller: {support: 'unknown', auth: 'unknown', enabled: false},
      extenders: [],
      stale: false,
    });

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
