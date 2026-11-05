// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {mount, unmount} from 'svelte';
import {defineMndwUi} from '@mndw/ui';
import type {SelfUpdateClient} from '../../../services/self-update-client.js';
import {defaultOverlayRuntime} from '../../../services/overlay/overlay-manager.svelte.js';
import SelfUpdateSettings from './SelfUpdateSettings.svelte';

const mountSettings = (client: SelfUpdateClient, options: {pollIntervalMs?: number; pollAttempts?: number} = {}) => {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(SelfUpdateSettings, {target, props: {client, ...options}});

  return {component, target};
};

beforeAll(() => {
  defineMndwUi();
});

afterEach(() => {
  for (const layer of [...defaultOverlayRuntime.store.layers]) {
    layer.close(undefined, 'api');
  }

  document.body.innerHTML = '';
  vi.useRealTimers();
});

function fakeClient(overrides: Partial<SelfUpdateClient> = {}): SelfUpdateClient {
  return {
    status: vi.fn().mockResolvedValue({state: 'idle', version: '0.0.3', rollbackVersion: '0.0.2'}),
    check: vi.fn().mockResolvedValue({
      currentVersion: '0.0.3',
      targetVersion: '0.0.4',
      updateAvailable: true,
      rollbackVersion: '0.0.2',
      rollbackAvailable: true,
    }),
    apply: vi.fn().mockResolvedValue({operation: 'update', targetVersion: '0.0.4'}),
    revert: vi.fn().mockResolvedValue({operation: 'revert', targetVersion: '0.0.2'}),
    ...overrides,
  };
}

describe('SelfUpdateSettings', () => {
  it('shows running and rollback versions', async () => {
    const client = fakeClient();
    const {component, target} = mountSettings(client);

    await vi.waitFor(() => expect(target.textContent).toContain('Running version: 0.0.3'));
    expect(target.textContent).toContain('Rollback version: 0.0.2');

    void unmount(component);
  });
});

it('uses accepted apply target and terminal status version', async () => {
  vi.useFakeTimers();

  const status = vi.fn()
    .mockResolvedValueOnce({state: 'idle', version: '0.0.3'})
    .mockResolvedValueOnce({state: 'in-progress', operation: 'update', version: '0.0.3', targetVersion: '0.0.5'})
    .mockResolvedValueOnce({state: 'idle', version: '0.0.5', rollbackVersion: '0.0.3'});
  let resolveApply: ((value: {operation: 'update'; targetVersion: string}) => void) | undefined;
  const client = fakeClient({
    status,
    apply: vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        resolveApply = resolve;
      });
    }),
  });
  const {component, target} = mountSettings(client, {pollIntervalMs: 10, pollAttempts: 3});

  await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
  target.querySelectorAll('mndw-button')[0]?.dispatchEvent(new Event('click', {bubbles: true}));
  await vi.waitFor(() => expect(target.textContent).toContain('Update available: 0.0.4'));
  target.querySelectorAll('mndw-button')[1]?.dispatchEvent(new Event('click', {bubbles: true}));
  await vi.waitFor(() => expect(defaultOverlayRuntime.store.layers).toHaveLength(1));
  defaultOverlayRuntime.store.layers[0]?.contentElement.querySelectorAll('mndw-button')[1]?.click();
  await vi.waitFor(() => expect(target.textContent).toContain('Preparing update…'));
  resolveApply?.({operation: 'update', targetVersion: '0.0.5'});
  await vi.advanceTimersByTimeAsync(10);
  await vi.advanceTimersByTimeAsync(10);
  await vi.waitFor(() => expect(target.textContent).toContain('Update complete. Running version: 0.0.5'));
  expect(status).toHaveBeenCalledTimes(3);

  void unmount(component);
});

it('requires confirmation before applying an update and opens a blocking progress modal', async () => {
  let resolveApply: ((value: {operation: 'update'; targetVersion: string}) => void) | undefined;
  const apply = vi.fn().mockImplementation(() => {
    return new Promise((resolve) => {
      resolveApply = resolve;
    });
  });
  const client = fakeClient({
    apply,
  });
  const {component, target} = mountSettings(client);

  await vi.waitFor(() => expect(target.querySelectorAll('mndw-button')[1]?.hasAttribute('disabled')).toBe(true));
  target.querySelectorAll('mndw-button')[0]?.click();
  await vi.waitFor(() => expect(target.textContent).toContain('Update available: 0.0.4'));
  target.querySelectorAll('mndw-button')[1]?.click();

  await vi.waitFor(() => expect(defaultOverlayRuntime.store.layers).toHaveLength(1));
  expect(apply).not.toHaveBeenCalled();
  expect(defaultOverlayRuntime.store.layers[0]?.contentElement.textContent).toContain('Install update to 0.0.4?');

  defaultOverlayRuntime.store.layers[0]?.contentElement.querySelectorAll('mndw-button')[1]?.click();

  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(defaultOverlayRuntime.store.layers).toHaveLength(1));

  const [progress] = defaultOverlayRuntime.store.layers;

  expect(progress?.closeOnEscape).toBe(false);
  expect(progress?.shell?.showCloseButton).toBe(false);
  expect(progress?.contentElement.textContent).toContain('Preparing update…');

  resolveApply?.({operation: 'update', targetVersion: '0.0.4'});
  void unmount(component);
});

it('requires confirmation before reverting', async () => {
  const revert = vi.fn().mockResolvedValue({operation: 'revert' as const, targetVersion: '0.0.2'});
  const client = fakeClient({revert});
  const {component, target} = mountSettings(client);

  await vi.waitFor(() => expect(target.textContent).toContain('Rollback version: 0.0.2'));
  target.querySelectorAll('mndw-button')[2]?.click();

  await vi.waitFor(() => expect(defaultOverlayRuntime.store.layers).toHaveLength(1));
  expect(revert).not.toHaveBeenCalled();
  expect(defaultOverlayRuntime.store.layers[0]?.contentElement.textContent).toContain('Revert to 0.0.2?');

  defaultOverlayRuntime.store.layers[0]?.contentElement.querySelectorAll('mndw-button')[1]?.click();
  await vi.waitFor(() => expect(revert).toHaveBeenCalledOnce());

  void unmount(component);
});

it('makes the progress modal closable when completion cannot be confirmed', async () => {
  vi.useFakeTimers();

  const status = vi.fn()
    .mockResolvedValueOnce({state: 'idle', version: '0.0.3', rollbackVersion: '0.0.2'})
    .mockResolvedValue({state: 'in-progress', operation: 'update', version: '0.0.3', targetVersion: '0.0.4'});
  const apply = vi.fn().mockResolvedValue({operation: 'update' as const, targetVersion: '0.0.4'});
  const client = fakeClient({status, apply});
  const {component, target} = mountSettings(client, {pollIntervalMs: 10, pollAttempts: 1});

  await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
  target.querySelectorAll('mndw-button')[0]?.click();
  await vi.waitFor(() => expect(target.textContent).toContain('Update available: 0.0.4'));
  target.querySelectorAll('mndw-button')[1]?.click();
  await vi.waitFor(() => expect(defaultOverlayRuntime.store.layers).toHaveLength(1));
  defaultOverlayRuntime.store.layers[0]?.contentElement.querySelectorAll('mndw-button')[1]?.click();

  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(defaultOverlayRuntime.store.layers[0]?.contentElement.textContent).toContain(
      'Updating to 0.0.4…',
    )
  );
  await vi.advanceTimersByTimeAsync(10);
  await vi.waitFor(() =>
    expect(defaultOverlayRuntime.store.layers[0]?.contentElement.textContent).toContain(
      'Unable to confirm self-update completion.',
    )
  );

  const [progress] = defaultOverlayRuntime.store.layers;

  expect(progress?.closeOnEscape).toBe(false);
  expect(progress?.shell?.showCloseButton).toBe(false);
  expect(progress?.contentElement.querySelector('mndw-button')).not.toBeNull();

  progress?.contentElement.querySelector('mndw-button')?.click();
  await vi.waitFor(() => expect(defaultOverlayRuntime.store.layers).toHaveLength(0));

  void unmount(component);
});

describe('SelfUpdateSettings errors', () => {
  it('does not expose raw failure detail', async () => {
    const client = fakeClient({
      status: vi.fn().mockResolvedValue({state: 'failed', version: '0.0.3', failureCode: 'opkg-install-failed'}),
    });
    const {component, target} = mountSettings(client);

    await vi.waitFor(() => expect(target.textContent).toContain('Update package installation failed.'));
    expect(target.textContent).not.toContain('opkg-install-failed');

    void unmount(component);
  });
});
