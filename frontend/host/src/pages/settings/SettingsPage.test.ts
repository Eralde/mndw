import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {defineMndwUi} from '@mndw/ui';
import {mount, unmount} from 'svelte';
import {MNDW_TOKENS} from '@mndw/sdk';

const {downloadDiagnostics, getCapability, probeControllerTokenAuth, saveController} = vi.hoisted(() => ({
  downloadDiagnostics: vi.fn(),
  getCapability: vi.fn().mockResolvedValue({
    store: {state: 'empty'},
    controller: {support: 'unknown'},
    extenders: [],
  }),
  probeControllerTokenAuth: vi.fn().mockResolvedValue(true),
  saveController: vi.fn(),
}));

vi.mock('../../services/mgmt-client.js', () => ({
  mgmtClient: {
    listPlugins: vi.fn().mockResolvedValue([]),
    uploadPlugin: vi.fn(),
    approvePlugin: vi.fn(),
    enablePlugin: vi.fn(),
    disablePlugin: vi.fn(),
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
}));
vi.mock('../../services/extender-access.service.js', () => ({
  extenderAccessService: {
    getExtenderAccess: vi.fn().mockResolvedValue({enabled: false}),
    setExtenderAccess: vi.fn().mockResolvedValue({enabled: false}),
    postForget: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../services/persistent-rci-session.service.js', () => ({
  persistentRciSessionService: {
    getCapability,
    probeControllerTokenAuth,
    testController: vi.fn(),
    saveController,
    clearController: vi.fn(),
    provisionExtenders: vi.fn(),
    clearExtenders: vi.fn(),
  },
}));
vi.mock('../../services/diagnostics.service.js', () => ({downloadDiagnostics}));

import SettingsPage from './SettingsPage.svelte';
import {toggleTheme} from '../../services/theme.service.js';

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
    });
    probeControllerTokenAuth.mockReset().mockResolvedValue(true);
    saveController.mockReset();
    downloadDiagnostics.mockReset();
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

  it('renders persistent-session settings and extender telemetry when configured', async () => {
    getCapability.mockResolvedValueOnce({
      store: {state: 'ok'},
      controller: {support: 'supported'},
      extenders: [{identity: 'node-1', name: 'Extender A', support: 'supported'}],
    });

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Persistent rci session"]')).not.toBeNull());

    await vi.waitFor(() => expect(target.querySelector('mndw-input[type="password"]')).not.toBeNull());
    expect(target.querySelector('section[aria-label="Extender access"]')).not.toBeNull();

    void unmount(component);
  });

  it.each([
    {
      name: 'there are no extenders',
      capability: {
        store: {state: 'ok'},
        controller: {support: 'supported'},
        extenders: [],
      },
    },
    {
      name: 'no extender has a supported persistent session',
      capability: {
        store: {state: 'ok'},
        controller: {support: 'supported'},
        extenders: [{identity: 'node-1', name: 'Extender A', support: 'unknown'}],
      },
    },
    {
      name: 'the controller token is invalid',
      capability: {
        store: {state: 'ok'},
        controller: {support: 'invalid'},
        extenders: [{identity: 'node-1', name: 'Extender A', support: 'supported'}],
      },
    },
  ])('hides extender telemetry access when $name', async ({capability}) => {
    getCapability.mockResolvedValueOnce(capability);

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Persistent rci session"]')).not.toBeNull());
    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Extender access"]')).toBeNull());

    void unmount(component);
  });

  it('hides extender telemetry access when controller token auth is not configured', async () => {
    getCapability.mockResolvedValueOnce({
      store: {state: 'empty'},
      controller: {support: 'unknown'},
      extenders: [{identity: 'node-1', name: 'Extender A', support: 'supported'}],
    });

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Persistent rci session"]')).not.toBeNull());

    const checkbox = target.querySelector<HTMLElement>('#mndw-persistent-rci-enabled');

    await vi.waitFor(() => expect(checkbox?.hasAttribute('disabled')).toBe(false));
    checkbox?.dispatchEvent(new CustomEvent('mndwchange', {bubbles: true, composed: true, detail: {checked: true}}));

    await vi.waitFor(() => expect(target.querySelector('section[aria-label="Extender access"]')).toBeNull());

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
