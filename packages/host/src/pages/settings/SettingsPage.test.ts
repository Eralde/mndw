import {afterEach, describe, expect, it, vi} from 'vitest';
import {mount, unmount} from 'svelte';

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
});
