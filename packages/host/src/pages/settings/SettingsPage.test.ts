import {afterEach, describe, expect, it, vi} from 'vitest';
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
vi.mock('../../services/palette.service.js', () => ({
  refreshPalette: vi.fn().mockResolvedValue(undefined),
  previewOverride: vi.fn(),
  discardPreview: vi.fn(),
  commitOverride: vi.fn().mockResolvedValue(undefined),
  resetToDefault: vi.fn().mockResolvedValue(undefined),
  getExportable: vi.fn(() => MNDW_TOKENS),
  getApplied: vi.fn(() => null),
}));

import SettingsPage from './SettingsPage.svelte';

describe('SettingsPage', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders plugin manager', async () => {
    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(SettingsPage, {target});

    await vi.waitFor(() => expect(target.querySelector('.mndw-plugin-manager')).not.toBeNull());

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
