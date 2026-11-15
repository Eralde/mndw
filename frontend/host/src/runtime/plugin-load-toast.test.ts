// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {PluginListEntry} from './plugin-types.js';
import {toast} from '../services/toast/toast.svelte.js';
import {replacePluginLoadStates, setPluginLoadState} from './plugin-load-state.svelte.js';
import {
  dismissPluginLoadFailureToast,
  resetPluginLoadFailureToast,
  syncPluginLoadFailureToast,
} from './plugin-load-toast.svelte.js';

function plugin(name: string, label: string): PluginListEntry {
  return {
    name,
    type: 'widget',
    version: '1.0.0',
    label,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    size: {w: 4, h: 3},
    backend: {routes: {}},
  } as PluginListEntry;
}

function failedPlugins(): void {
  replacePluginLoadStates([plugin('zeta', 'Zulu'), plugin('alpha', 'Alpha')]);
  setPluginLoadState('zeta', 'failed', 'error');
  setPluginLoadState('alpha', 'failed', 'timeout');
}

afterEach(() => {
  resetPluginLoadFailureToast();
  toast.clear();
  replacePluginLoadStates([]);
  vi.restoreAllMocks();
});

describe('plugin load failure toast', () => {
  it('shows one toast with labels sorted by display label', () => {
    failedPlugins();

    syncPluginLoadFailureToast(vi.fn(() => Promise.resolve(false)), () => true);
    syncPluginLoadFailureToast(vi.fn(() => Promise.resolve(false)), () => true);

    expect(toast.toasts).toHaveLength(1);
    expect(toast.toasts[0]).toMatchObject({
      key: 'plugin-load',
      variant: 'error',
      message: 'Plugins failed to load: Alpha, Zulu',
      action: {label: 'Retry'},
    });
  });

  it('retries every failed plugin and replaces the failure toast with success', async () => {
    failedPlugins();

    const retryResolves = new Map<string, (loaded: boolean) => void>();
    const retry = vi.fn((name: string) => {
      setPluginLoadState(name, 'loading');

      return new Promise<boolean>((resolve) => retryResolves.set(name, resolve));
    });

    syncPluginLoadFailureToast(retry, () => true);

    const failureToast = toast.toasts[0];
    const retrying = failureToast?.action?.onAction();

    expect(toast.toasts[0]?.action?.busy).toBe(true);

    for (const name of ['alpha', 'zeta']) {
      setPluginLoadState(name, 'loaded');
      retryResolves.get(name)?.(true);
    }

    await retrying;

    expect(retry.mock.calls.map(([name]) => name).sort()).toEqual(['alpha', 'zeta']);
    expect(toast.toasts).toHaveLength(1);
    expect(toast.toasts[0]).toMatchObject({
      key: 'plugin-load',
      variant: 'success',
      message: 'Plugins loaded',
    });
  });
});

describe('plugin load failure toast updates', () => {
  it('updates the failure toast with names that remain after partial success', async () => {
    failedPlugins();

    const retry = vi.fn((name: string) => {
      if (name === 'alpha') {
        setPluginLoadState(name, 'loaded');
      }

      return Promise.resolve(name === 'alpha');
    });

    syncPluginLoadFailureToast(retry, () => true);

    await toast.toasts[0]?.action?.onAction();

    expect(toast.toasts).toHaveLength(1);
    expect(toast.toasts[0]).toMatchObject({
      key: 'plugin-load',
      variant: 'error',
      message: 'Plugins failed to load: Zulu',
    });
  });

  it('does not show a toast for a stale generation', () => {
    failedPlugins();

    syncPluginLoadFailureToast(vi.fn(() => Promise.resolve(false)), () => false);

    expect(toast.toasts).toHaveLength(0);
  });

  it('does not let an older auth run dismiss the current toast', () => {
    const olderOwner = resetPluginLoadFailureToast();
    const currentOwner = resetPluginLoadFailureToast();

    failedPlugins();
    syncPluginLoadFailureToast(vi.fn(() => Promise.resolve(false)), () => true);

    dismissPluginLoadFailureToast(olderOwner);

    expect(toast.toasts[0]?.message).toBe('Plugins failed to load: Alpha, Zulu');

    dismissPluginLoadFailureToast(currentOwner);

    expect(toast.toasts).toHaveLength(0);
  });
});
