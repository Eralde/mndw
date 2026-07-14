// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type PackageEntry} from '../services/opkg-client.js';

const mockList = vi.fn<(...args: unknown[]) => Promise<PackageEntry[]>>();
const mockUpdate = vi.fn<(...args: unknown[]) => Promise<{message: string}>>();

vi.mock('../services/opkg-client.js', () => ({
  OpkgError: Error,
  get opkgClient() {
    return {
      list: mockList,
      update: mockUpdate,
    };
  },
}));

import PackageManager from './opkg/PackageManager.svelte';

describe('PackageManager', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.clearAllMocks();
    host.remove();
  });

  it('shows an empty catalog as an informational state', async () => {
    mockList.mockResolvedValue([]);

    const app = mount(PackageManager, {target: host});

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('No packages found');
    });

    expect(host.textContent).toContain('No packages found');
    await unmount(app);
  });

  it('shows a load error for a rejected list', async () => {
    mockList.mockRejectedValue(new Error('offline'));

    const app = mount(PackageManager, {target: host});

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Failed to load packages');
    });

    expect(host.textContent).toContain('Failed to load packages');
    await unmount(app);
  });

  it('preserves action feedback after reloading the list', async () => {
    mockList.mockResolvedValue([]);
    mockUpdate.mockResolvedValue({message: 'Package metadata refreshed'});

    const app = mount(PackageManager, {target: host});

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('No packages found');
    });

    const refreshButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.trim() === 'Refresh Metadata'
    );

    refreshButton?.click();
    flushSync();
    await vi.waitFor(() => expect(host.textContent).toContain('Package metadata refreshed'));
    await unmount(app);
  });
});
