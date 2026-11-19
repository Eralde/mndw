// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {defineMndwUi} from '@mndw/ui';
import {mount as mountComponent, unmount} from 'svelte';

const {
  downloadDiagnostics,
  clearController,
  getCapability,
  saveController,
  setEnabled,
  selfUpdateStatus,
  toggleTheme,
} = vi.hoisted(() => ({
  downloadDiagnostics: vi.fn(),
  clearController: vi.fn().mockResolvedValue(undefined),
  getCapability: vi.fn().mockResolvedValue({
    store: {state: 'empty'},
    controller: {support: 'unknown', auth: 'unknown', enabled: false},
    extenders: [],
    stale: false,
  }),
  saveController: vi.fn(),
  setEnabled: vi.fn().mockResolvedValue(undefined),
  selfUpdateStatus: vi.fn().mockResolvedValue({state: 'idle', version: 'dev'}),
  toggleTheme: vi.fn(),
}));

vi.mock('../../services/mgmt-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/mgmt-client.js')>(),
  createMgmtClient: () => ({
    listPlugins: vi.fn().mockResolvedValue([]),
    uploadPlugin: vi.fn(),
    approvePlugin: vi.fn(),
    enablePlugin: vi.fn(),
    disablePlugin: vi.fn(),
    setPluginCapability: vi.fn(),
    denyPlugin: vi.fn(),
    deletePlugin: vi.fn(),
    getTelemetry: vi.fn().mockResolvedValue({enabled: false}),
  }),
}));
vi.mock('../../services/theme.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/theme.service.js')>();

  return {
    ...original,
    createThemeService: (deps: Parameters<typeof original.createThemeService>[0]) => {
      const service = original.createThemeService(deps);

      return {...service, toggleTheme: () => {
        toggleTheme();
        service.toggleTheme();
      }};
    },
  };
});
vi.mock('../../services/palette.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/palette.service.js')>();

  return {
    ...original,
    createPaletteService: (deps: Parameters<typeof original.createPaletteService>[0]) => ({
      ...original.createPaletteService(deps),
      refreshPalette: vi.fn().mockResolvedValue(undefined),
      previewOverride: vi.fn(),
      discardPreview: vi.fn(),
      commitOverride: vi.fn().mockResolvedValue(undefined),
      resetToDefault: vi.fn().mockResolvedValue(undefined),
    }),
  };
});
vi.mock('../../services/persistent-rci-session.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/persistent-rci-session.service.js')>();

  return {
    ...original,
    createPersistentRciSessionService: () => ({
      getCapability,
      testController: vi.fn(),
      saveController,
      clearController,
      setEnabled,
    }),
  };
});
vi.mock('../../services/diagnostics.service.js', () => ({downloadDiagnostics}));
vi.mock('../../services/self-update-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/self-update-client.js')>();

  return {
    ...original,
    createSelfUpdateClient: () => ({
      status: selfUpdateStatus,
      check: vi.fn(),
      apply: vi.fn(),
      revert: vi.fn(),
    }),
  };
});

import SettingsPage from './SettingsPage.svelte';
import generalSettingsSource from './GeneralSettings.svelte?raw';
import {createHostServices} from '../../host-services.js';
import {createHostServicesContext} from '../../host-services-context.js';
import {toast} from '../../services/toast/toast.svelte.js';
import {PersistentRciSessionError} from '../../services/persistent-rci-session.service.js';

let activeServices!: ReturnType<typeof createHostServices>;

const mount = (component: typeof SettingsPage, options: {target: HTMLElement}) => {
  const services = createHostServices({fetch: vi.fn<typeof globalThis.fetch>()});
  activeServices = services;
  services.router.create(services.registry);

  return mountComponent(component, {
    ...options,
    context: createHostServicesContext(services),
  });
};

beforeAll(() => {
  defineMndwUi();
});

describe('SettingsPage', () => {
  afterEach(() => {
    for (const layer of [...activeServices.overlayRuntime.store.layers]) {
      layer.close();
    }

    document.body.innerHTML = '';
    toast.clear();
    toggleTheme.mockClear();
    getCapability.mockReset().mockResolvedValue({
      store: {state: 'empty'},
      controller: {support: 'unknown', auth: 'unknown', enabled: false},
      extenders: [],
      stale: false,
    });
    saveController.mockReset();
    clearController.mockReset().mockResolvedValue(undefined);
    setEnabled.mockReset().mockResolvedValue(undefined);
    downloadDiagnostics.mockReset();
    selfUpdateStatus.mockReset().mockResolvedValue({state: 'idle', version: 'dev'});
    globalThis.history.replaceState({}, '', '/settings/general');
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

  it('navigates to selected child route', async () => {
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

    await vi.waitFor(() => expect(activeServices.router.current?.route.pathname).toBe('/settings/diagnostics'));

    void unmount(component);
  });

  it('redirects the settings entry route to General with history replacement', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const services = createHostServices({fetch: vi.fn<typeof globalThis.fetch>()});
    activeServices = services;
    const router = services.router.create(services.registry);

    await router.navigate('/settings', {replace: true});

    const component = mountComponent(SettingsPage, {
      target,
      context: createHostServicesContext(services),
    });

    await vi.waitFor(() => expect(router.route.pathname).toBe('/settings/general'));

    void unmount(component);
  });

  it('selects tab from child route', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await activeServices.router.current?.navigate('/settings/plugins');

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

    await vi.waitFor(() =>
      expect(target.querySelector('section[aria-label="Background router access"]')).not.toBeNull()
    );

    const headings = [...target.querySelectorAll('h3')].map((heading) => heading.textContent?.trim());

    expect(headings.slice(0, 3)).toEqual(['Interface', 'Palette', 'Device']);
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

    await vi.waitFor(() =>
      expect(target.querySelector('section[aria-label="Background router access"]')).not.toBeNull()
    );
    await vi.waitFor(() => expect(target.textContent).toContain('Controller and extender access'));

    const control = target.querySelector<HTMLElement & {checked: boolean}>('#mndw-persistent-rci-enabled');

    expect(control?.checked).toBe(true);
    expect(target.querySelector('mndw-input[type="password"]')).toBeNull();
    expect(target.textContent).toContain('Controller and extender access');

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

    await vi.waitFor(() => expect(toast.toasts[0]?.message).toBe('Device unreachable'));
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
      expect(target.textContent).toContain('Background router access state unavailable');
      expect(toast.toasts[0]?.message).toBe('Device unreachable');
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
      expect(target.textContent).toContain('Firmware now requires a controller token for background router access.')
    );
    expect(target.querySelector('mndw-input[type="password"]')).not.toBeNull();

    void unmount(component);
  });

  it('shows state unavailable when auth mode is unknown', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.textContent).toContain('Background router access state unavailable'));
    expect(target.querySelector('#mndw-persistent-rci-enabled')).toBeNull();

    void unmount(component);
  });

  it('shows state unavailable when capability request fails', async () => {
    getCapability.mockRejectedValueOnce(new Error('ignored detail'));

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.textContent).toContain('Background router access state unavailable'));
    expect(target.querySelector('#mndw-persistent-rci-enabled')).toBeNull();

    void unmount(component);
  });

  it('shows telemetry section when background router access is enabled', async () => {
    getCapability.mockResolvedValueOnce({
      store: {state: 'empty'},
      controller: {support: 'supported', auth: 'none', enabled: true},
      extenders: [],
      stale: false,
    });

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => {
      expect(target.querySelector<HTMLElement & {disabled: boolean}>('#mndw-telemetry-enabled')?.disabled).toBe(false);
    });

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

    await vi.waitFor(() => expect(target.querySelector('#mndw-persistent-rci-enabled')).not.toBeNull());
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
      expect(target.querySelector('mndw-input[type="password"]')?.getAttribute('placeholder')).toBe('Token is set')
    );

    void unmount(component);
  });

  it('requires confirmation before clearing controller access', async () => {
    getCapability.mockResolvedValueOnce({
      store: {state: 'empty'},
      controller: {support: 'supported', auth: 'token', enabled: true},
      extenders: [],
      stale: false,
    });

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    const clearButton = await vi.waitFor(() => {
      const value = [...target.querySelectorAll('mndw-button')]
        .find((button) => button.textContent?.trim() === 'Clear controller access');

      if (value === undefined) {
        throw new Error('clear controller button not rendered');
      }

      return value;
    });

    clearButton.click();

    await vi.waitFor(() => expect(activeServices.overlayRuntime.store.layers).toHaveLength(1));
    expect(activeServices.overlayRuntime.store.layers[0]?.contentElement.textContent)
      .toContain('Persistent RCI sessions will stop until you save a controller token again.');
    expect(clearController).not.toHaveBeenCalled();

    activeServices.overlayRuntime.store.layers[0]?.contentElement.querySelectorAll('mndw-button')[1]?.click();

    await vi.waitFor(() => expect(clearController).toHaveBeenCalledOnce());

    void unmount(component);
  });

  it('does not clear controller access when confirmation is canceled', async () => {
    getCapability.mockResolvedValueOnce({
      store: {state: 'empty'},
      controller: {support: 'supported', auth: 'token', enabled: true},
      extenders: [],
      stale: false,
    });

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    const clearButton = await vi.waitFor(() => {
      const value = [...target.querySelectorAll('mndw-button')]
        .find((button) => button.textContent?.trim() === 'Clear controller access');

      if (value === undefined) {
        throw new Error('clear controller button not rendered');
      }

      return value;
    });

    clearButton.click();
    await vi.waitFor(() => expect(activeServices.overlayRuntime.store.layers).toHaveLength(1));
    activeServices.overlayRuntime.store.layers[0]?.contentElement.querySelectorAll('mndw-button')[0]?.click();

    await vi.waitFor(() => expect(activeServices.overlayRuntime.store.layers).toHaveLength(0));
    expect(clearController).not.toHaveBeenCalled();

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
    await vi.waitFor(() => expect(toast.toasts[0]?.message).toBe('Diagnostics download failed'));
    expect(target.textContent).not.toContain('DO_NOT_EXPORT');

    void unmount(component);
  });
});
