import {afterEach, describe, expect, it, vi} from 'vitest';
import {type ComponentProps, flushSync, mount, unmount} from 'svelte';

import type {UploadResult} from '../../../services/mgmt-client.js';
import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import PluginUpload from './PluginUpload.svelte';

const entry: PluginListEntry = {
  type: 'page',
  name: 'network-tools',
  version: '1.0.0',
  label: 'Network Tools',
  entry: 'index.js',
  source: 'user',
  approval: 'pending',
  enabled: false,
  route: '/network-tools',
  backend: {
    endpoints: {},
    websockets: {},
    opkg: [],
    daemon: true,
    public: false,
  },
};

function mountUpload(overrides: Partial<ComponentProps<typeof PluginUpload>> = {}) {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(PluginUpload, {
    target,
    props: {
      uploadFile: vi.fn(),
      onInstalled: vi.fn(),
      onApprove: vi.fn(),
      onDeny: vi.fn(),
      onDismiss: vi.fn(),
      ...overrides,
    },
  });

  flushSync();

  return {component, target};
}

async function drop(target: HTMLElement, file: File): Promise<void> {
  const dataTransfer = new DataTransfer();

  dataTransfer.items.add(file);

  const event = new DragEvent('drop', {bubbles: true});

  Object.defineProperty(event, 'dataTransfer', {value: dataTransfer});
  target.querySelector<HTMLElement>('.mndw-upload__zone')?.dispatchEvent(event);
  await Promise.resolve();
  flushSync();
}

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve(value: T): void {
      resolve?.(value);
    },
  };
}

describe('PluginUpload', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('rejects a non-ZIP drop without uploading', async () => {
    const uploadFile = vi.fn();
    const {component, target} = mountUpload({uploadFile});

    await drop(target, new File(['plugin'], 'plugin.tar.gz', {type: 'application/gzip'}));

    expect(uploadFile).not.toHaveBeenCalled();
    expect(target.querySelector('.mndw-upload__error')?.textContent).toContain('ZIP');
    expect(target.querySelector('.mndw-upload__error')?.getAttribute('role')).toBe('alert');

    void unmount(component);
  });

  it('shows labeled installed success and notifies manager', async () => {
    const onInstalled = vi.fn();
    const uploadFile = vi.fn().mockResolvedValue({status: 'installed', entry} satisfies UploadResult);
    const {component, target} = mountUpload({uploadFile, onInstalled});

    await drop(target, new File(['plugin'], 'plugin.zip', {type: 'application/zip'}));

    expect(onInstalled).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(target.querySelector('.mndw-upload__success')?.textContent).toBe('Installed "Network Tools".');
    });
    expect(target.querySelector('.mndw-upload__success')?.getAttribute('role')).toBe('status');

    void unmount(component);
  });

  it('starts only one upload while an earlier drop is pending', async () => {
    const uploadFile = vi.fn(() => new Promise<UploadResult>(() => undefined));
    const {component, target} = mountUpload({uploadFile});

    await drop(target, new File(['first'], 'first.zip', {type: 'application/zip'}));
    await drop(target, new File(['second'], 'second.zip', {type: 'application/zip'}));

    expect(uploadFile).toHaveBeenCalledOnce();
    expect(target.querySelector('.mndw-upload__status')?.textContent).toBe('Uploading plugin...');
    expect(target.querySelector('.mndw-upload__status')?.getAttribute('role')).toBe('status');

    void unmount(component);
  });

  it('ignores a deferred upload result after teardown', async () => {
    const result = deferred<UploadResult>();
    const uploadFile = vi.fn().mockReturnValue(result.promise);
    const onInstalled = vi.fn();
    const onDismiss = vi.fn();
    const openApproval = vi.fn();
    const {component, target} = mountUpload({uploadFile, onInstalled, onDismiss, openApproval});

    await drop(target, new File(['plugin'], 'plugin.zip', {type: 'application/zip'}));
    await unmount(component);
    result.resolve({status: 'pending', entry});
    await new Promise((resolve) => setTimeout(resolve));

    expect(onInstalled).not.toHaveBeenCalled();
    expect(openApproval).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(target.textContent).toBe('');
  });

  it('shows busy feedback then approved success for a pending upload', async () => {
    const onApprove = vi.fn().mockResolvedValue(true);
    const onDeny = vi.fn();
    let resolveApproval: ((decision: 'approve') => void) | undefined;
    const openApproval = vi.fn(
      () =>
        new Promise<'approve'>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const uploadFile = vi.fn().mockResolvedValue({status: 'pending', entry} satisfies UploadResult);
    const {component, target} = mountUpload({uploadFile, onApprove, onDeny, openApproval});

    await drop(target, new File(['plugin'], 'plugin.zip', {type: 'application/zip'}));
    await vi.waitFor(() => {
      expect(target.querySelector('.mndw-upload__status')?.textContent).toBe('Waiting for approval...');
    });
    expect(target.querySelector('.mndw-upload__status')?.getAttribute('role')).toBe('status');

    if (!resolveApproval) {
      throw new Error('Approval modal did not open.');
    }

    resolveApproval('approve');
    await vi.waitFor(() => expect(onApprove).toHaveBeenCalledWith(entry.name));

    expect(onDeny).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(target.querySelector('.mndw-upload__success')?.textContent).toBe('Approved "Network Tools".');
    });

    void unmount(component);
  });

  it('denies a pending upload when approval modal denies', async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const openApproval = vi.fn().mockResolvedValue('deny');
    const uploadFile = vi.fn().mockResolvedValue({status: 'pending', entry} satisfies UploadResult);
    const {component, target} = mountUpload({uploadFile, onApprove, onDeny, openApproval});

    await drop(target, new File(['plugin'], 'plugin.zip', {type: 'application/zip'}));
    await vi.waitFor(() => expect(onDeny).toHaveBeenCalledWith(entry.name));

    expect(onApprove).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(target.querySelector('.mndw-upload__status')).toBeNull());
    expect(target.querySelector('.mndw-upload__success')).toBeNull();

    void unmount(component);
  });

  it('does not show approval success when manager rejects approval', async () => {
    const onApprove = vi.fn().mockResolvedValue(false);
    const openApproval = vi.fn().mockResolvedValue('approve');
    const uploadFile = vi.fn().mockResolvedValue({status: 'pending', entry} satisfies UploadResult);
    const {component, target} = mountUpload({uploadFile, onApprove, openApproval});

    await drop(target, new File(['plugin'], 'plugin.zip', {type: 'application/zip'}));
    await vi.waitFor(() => expect(onApprove).toHaveBeenCalledWith(entry.name));

    expect(target.querySelector('.mndw-upload__success')).toBeNull();
    await vi.waitFor(() => expect(target.querySelector('.mndw-upload__status')).toBeNull());

    void unmount(component);
  });

  it('notifies dismissal when pending approval modal is dismissed', async () => {
    const onDismiss = vi.fn();
    const openApproval = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockResolvedValue({status: 'pending', entry} satisfies UploadResult);
    const {component, target} = mountUpload({uploadFile, onDismiss, openApproval});

    await drop(target, new File(['plugin'], 'plugin.zip', {type: 'application/zip'}));
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(target.querySelector('.mndw-upload__status')).toBeNull());
    expect(target.querySelector('.mndw-upload__success')).toBeNull();

    void unmount(component);
  });

  it('aborts a pending approval on teardown without calling manager callbacks', async () => {
    const onApprove = vi.fn();
    const onDismiss = vi.fn();
    let resolveApproval: ((decision: 'approve') => void) | undefined;
    let signal: AbortSignal | undefined;
    const openApproval = vi.fn(
      (_entry: PluginListEntry, approvalSignal?: AbortSignal) =>
        new Promise<'approve'>((resolve) => {
          signal = approvalSignal;
          resolveApproval = resolve;
        }),
    );
    const uploadFile = vi.fn().mockResolvedValue({status: 'pending', entry} satisfies UploadResult);
    const {component, target} = mountUpload({uploadFile, onApprove, onDismiss, openApproval});

    await drop(target, new File(['plugin'], 'plugin.zip', {type: 'application/zip'}));
    await vi.waitFor(() => expect(signal).toBeDefined());

    await unmount(component);
    expect(signal?.aborted).toBe(true);

    resolveApproval?.('approve');
    await Promise.resolve();

    expect(onApprove).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
