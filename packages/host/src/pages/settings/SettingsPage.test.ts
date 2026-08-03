import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {defineMndwUi} from '@mndw/ui';
import {mount, unmount} from 'svelte';
import {MNDW_TOKENS} from '@mndw/sdk';

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

import SettingsPage from './SettingsPage.svelte';
import {toggleTheme} from '../../services/theme.service.js';

beforeAll(() => {
  defineMndwUi();
});

describe('SettingsPage', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.mocked(toggleTheme).mockClear();
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

  it('renders the palette manager between Appearance and Device', () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});
    const headings = [...target.querySelectorAll('h3')].map((heading) => heading.textContent?.trim());

    expect(headings).toEqual(['Appearance', 'Palette', 'Device']);
    expect(target.querySelector('.mndw-palette-manager')).not.toBeNull();
    expect(target.querySelector('.mndw-plugin-manager')).not.toBeNull();

    void unmount(component);
  });
});
