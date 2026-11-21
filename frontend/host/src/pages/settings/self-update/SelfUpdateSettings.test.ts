// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {mount, unmount} from 'svelte';
import {defineMndwUi} from '@mndw/ui';
import {type SelfUpdateClient, SelfUpdateError} from '../../../services/self-update-client.js';
import {createHostServices} from '../../../host-services.js';
import {createHostServicesContext} from '../../../host-services-context.js';
import {hostT} from '../../../services/host-i18n.svelte.js';
import {toast} from '../../../services/toast/toast.svelte.js';
import SelfUpdateSettings from './SelfUpdateSettings.svelte';

let activeServices!: ReturnType<typeof createHostServices>;

const mountSettings = (client: SelfUpdateClient, options: {pollIntervalMs?: number; pollAttempts?: number} = {}) => {
  const target = document.createElement('div');
  activeServices = createHostServices();

  document.body.appendChild(target);

  const component = mount(SelfUpdateSettings, {
    target,
    props: {client, ...options},
    context: createHostServicesContext(activeServices),
  });

  return {component, target};
};

beforeAll(() => {
  defineMndwUi();
});

afterEach(() => {
  for (const layer of [...activeServices.overlayRuntime.store.layers]) {
    layer.close(undefined, 'api');
  }

  document.body.innerHTML = '';
  toast.clear();
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

  it('shows an info toast when Check completes with no update available', async () => {
    const client = fakeClient({
      check: vi.fn().mockResolvedValue({
        currentVersion: '0.0.3',
        updateAvailable: false,
        rollbackAvailable: false,
      }),
    });
    const {component, target} = mountSettings(client);

    await vi.waitFor(() => expect(target.textContent).toContain('Running version: 0.0.3'));
    target.querySelectorAll('mndw-button')[0]?.click();

    await vi.waitFor(() =>
      expect(toast.toasts[0]).toMatchObject({
        key: 'settings.self-update.check',
        variant: 'info',
        message: hostT('settings.self-update-no-update'),
      })
    );
    expect(target.textContent).not.toContain('Update available:');
    await unmount(component);
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
  await vi.waitFor(() => expect(activeServices.overlayRuntime.store.layers).toHaveLength(1));
  activeServices.overlayRuntime.store.layers[0]?.contentElement.querySelectorAll('mndw-button')[1]?.click();
  await vi.waitFor(() => expect(target.textContent).toContain('Preparing update…'));
  resolveApply?.({operation: 'update', targetVersion: '0.0.5'});
  await vi.advanceTimersByTimeAsync(10);
  await vi.advanceTimersByTimeAsync(10);
  await vi.waitFor(() =>
    expect(toast.toasts[0]).toMatchObject({
      variant: 'success',
      message: 'Update complete. Running version: 0.0.5',
    })
  );
  expect(target.querySelector('[role="status"]')).toBeNull();
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

  await vi.waitFor(() => expect(activeServices.overlayRuntime.store.layers).toHaveLength(1));
  expect(apply).not.toHaveBeenCalled();
  expect(activeServices.overlayRuntime.store.layers[0]?.shell?.description).toBe(
    'Install update to 0.0.4? mndw will restart.',
  );

  activeServices.overlayRuntime.store.layers[0]?.contentElement.querySelectorAll('mndw-button')[1]?.click();

  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(activeServices.overlayRuntime.store.layers).toHaveLength(1));

  const [progress] = activeServices.overlayRuntime.store.layers;

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

  await vi.waitFor(() => expect(activeServices.overlayRuntime.store.layers).toHaveLength(1));
  expect(revert).not.toHaveBeenCalled();
  expect(activeServices.overlayRuntime.store.layers[0]?.shell?.description).toBe(
    'Revert to 0.0.2? mndw will restart.',
  );

  activeServices.overlayRuntime.store.layers[0]?.contentElement.querySelectorAll('mndw-button')[1]?.click();
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
  await vi.waitFor(() => expect(activeServices.overlayRuntime.store.layers).toHaveLength(1));
  activeServices.overlayRuntime.store.layers[0]?.contentElement.querySelectorAll('mndw-button')[1]?.click();

  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(activeServices.overlayRuntime.store.layers[0]?.contentElement.textContent).toContain(
      'Updating to 0.0.4…',
    )
  );
  await vi.advanceTimersByTimeAsync(10);
  await vi.waitFor(() =>
    expect(activeServices.overlayRuntime.store.layers[0]?.contentElement.textContent).toContain(
      'Unable to confirm self-update completion.',
    )
  );

  const [progress] = activeServices.overlayRuntime.store.layers;

  expect(progress?.contentElement.querySelector('[role="status"]')).not.toBeNull();
  expect(progress?.contentElement.querySelector('[role="alert"]')).toBeNull();
  expect(progress?.closeOnEscape).toBe(false);
  expect(progress?.shell?.showCloseButton).toBe(false);
  expect(progress?.contentElement.querySelector('mndw-button')).not.toBeNull();

  progress?.contentElement.querySelector('mndw-button')?.click();
  await vi.waitFor(() => expect(activeServices.overlayRuntime.store.layers).toHaveLength(0));
  expect(target.querySelector('[role="status"]')?.textContent).toContain(
    hostT('settings.self-update-unconfirmed'),
  );
  expect(target.querySelector('[role="alert"]')).toBeNull();

  void unmount(component);
});

describe('SelfUpdateSettings errors', () => {
  it('does not expose raw failure detail', async () => {
    const client = fakeClient({
      status: vi.fn().mockResolvedValue({state: 'failed', version: '0.0.3', failureCode: 'opkg-install-failed'}),
    });
    const {component, target} = mountSettings(client);

    await vi.waitFor(() => expect(target.textContent).toContain('Update package installation failed.'));
    expect(target.querySelector('[role="alert"]')).not.toBeNull();
    expect(target.textContent).not.toContain('opkg-install-failed');

    void unmount(component);
  });

  it.each(
    [
      {code: 'SELF_UPDATE_NOT_AVAILABLE', variant: 'info', messageKey: 'settings.self-update-no-update'},
      {code: 'SELF_UPDATE_ROLLBACK_UNAVAILABLE', variant: 'info',
        messageKey: 'settings.self-update-rollback-unavailable'},
      {code: 'UNKNOWN', variant: 'error', messageKey: 'settings.self-update-failure-generic'},
    ] as const,
  )('shows $code action outcome as a toast', async ({code, variant, messageKey}) => {
    const client = fakeClient({apply: vi.fn().mockRejectedValue(new SelfUpdateError('private detail', code))});
    const {component, target} = mountSettings(client);

    target.querySelectorAll('mndw-button')[0]?.click();
    await vi.waitFor(() => expect(target.textContent).toContain('Update available: 0.0.4'));
    target.querySelectorAll('mndw-button')[1]?.click();
    await vi.waitFor(() => expect(activeServices.overlayRuntime.store.layers).toHaveLength(1));
    activeServices.overlayRuntime.store.layers[0]?.contentElement.querySelectorAll('mndw-button')[1]?.click();

    await vi.waitFor(() =>
      expect(toast.toasts[0]).toMatchObject({
        variant,
        message: hostT(messageKey),
      })
    );
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(target.textContent).not.toContain('private detail');

    void unmount(component);
  });
});
