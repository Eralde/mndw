import {type Mocked, afterEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import type {MgmtClient, UploadResult} from '../../../services/mgmt-client.js';
import PluginManager from './PluginManager.svelte';

const emptyBackend = {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false};

function plugin(overrides: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    type: 'widget',
    name: 'network-tools',
    version: '1.0.0',
    label: 'Network Tools',
    entry: 'index.js',
    source: 'user',
    approval: 'approved',
    enabled: true,
    size: {w: 4, h: 3},
    backend: emptyBackend,
    ...overrides,
  } as PluginListEntry;
}

function clientWith(items: PluginListEntry[]): Mocked<MgmtClient> {
  return {
    listPlugins: vi.fn().mockResolvedValue(items),
    uploadPlugin: vi.fn(),
    approvePlugin: vi.fn().mockResolvedValue(items[0]),
    enablePlugin: vi.fn().mockResolvedValue(items[0]),
    disablePlugin: vi.fn().mockResolvedValue(items[0]),
    denyPlugin: vi.fn().mockResolvedValue(undefined),
    deletePlugin: vi.fn().mockResolvedValue(undefined),
    getPalette: vi.fn().mockResolvedValue(null),
    putPalette: vi.fn().mockResolvedValue(undefined),
    deletePalette: vi.fn().mockResolvedValue(undefined),
  } as Mocked<MgmtClient>;
}

async function mountManager(
  client: Mocked<MgmtClient>,
): Promise<{component: ReturnType<typeof mount>; target: HTMLElement}> {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(PluginManager, {target, props: {client}});

  await vi.waitFor(() => expect(client.listPlugins.mock.calls).toHaveLength(1));
  flushSync();

  return {component, target};
}

function dropPlugin(target: HTMLElement): void {
  const dataTransfer = new DataTransfer();

  dataTransfer.items.add(new File(['plugin'], 'plugin.zip', {type: 'application/zip'}));

  const event = new DragEvent('drop', {bubbles: true});

  Object.defineProperty(event, 'dataTransfer', {value: dataTransfer});
  target.querySelector<HTMLElement>('.mndw-upload__zone')?.dispatchEvent(event);
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

describe('PluginManager', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('loads plugins and partitions pending approvals from installed plugins', async () => {
    const client = clientWith([
      plugin(),
      plugin({name: 'needs-review', label: 'Needs Review', approval: 'pending', enabled: false}),
    ]);
    const {component, target} = await mountManager(client);

    expect(target.querySelector('.mndw-pending')?.textContent).toContain('Needs Review');
    expect(target.querySelector('.mndw-installed')?.textContent).toContain('Network Tools');
    expect(target.querySelector('.mndw-installed')?.textContent).not.toContain('Needs Review');

    void unmount(component);
  });

  it('does not render pending approvals when none are pending', async () => {
    const {component, target} = await mountManager(clientWith([plugin()]));

    expect(target.querySelector('.mndw-pending')).toBeNull();
    expect(target.querySelector('.mndw-installed')).not.toBeNull();

    void unmount(component);
  });

  it('calls injected upload client with its receiver bound', async () => {
    const client = clientWith([plugin()]);

    client.uploadPlugin = vi.fn(function(this: MgmtClient, _file: File): Promise<UploadResult> {
      return this.listPlugins().then(() => ({status: 'installed', entry: plugin()}));
    });

    const {component, target} = await mountManager(client);

    dropPlugin(target);
    await vi.waitFor(() => {
      expect(target.querySelector('.mndw-upload__success')?.textContent).toContain('Installed');
    });

    expect(client.uploadPlugin.mock.calls).toHaveLength(1);

    void unmount(component);
  });

  it('keeps newer plugins when an older list request resolves last', async () => {
    const initial = deferred<PluginListEntry[]>();
    const refreshed = deferred<PluginListEntry[]>();
    const client = clientWith([]);

    client.listPlugins
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);
    client.uploadPlugin.mockResolvedValue({status: 'installed', entry: plugin()});

    const target = document.createElement('div');

    document.body.appendChild(target);

    const component = mount(PluginManager, {target, props: {client}});

    await vi.waitFor(() => expect(client.listPlugins.mock.calls).toHaveLength(1));

    dropPlugin(target);
    await vi.waitFor(() => expect(client.listPlugins.mock.calls).toHaveLength(2));
    refreshed.resolve([plugin({label: 'Newest Plugin'})]);
    await vi.waitFor(() => expect(target.textContent).toContain('Newest Plugin'));
    initial.resolve([plugin({label: 'Older Plugin'})]);
    await Promise.resolve();
    flushSync();

    expect(target.textContent).toContain('Newest Plugin');
    expect(target.textContent).not.toContain('Older Plugin');

    void unmount(component);
  });

  it('disables a plugin, refreshes the list, and offers reload', async () => {
    const client = clientWith([plugin()]);
    const {component, target} = await mountManager(client);

    client.listPlugins.mockClear();

    target.querySelector<HTMLButtonElement>('.mndw-installed__toggle')?.click();
    await vi.waitFor(() => expect(client.disablePlugin.mock.calls).toContainEqual(['network-tools']));
    await vi.waitFor(() => expect(client.listPlugins.mock.calls).toHaveLength(1));

    expect(target.querySelector('.mndw-reload')).not.toBeNull();

    void unmount(component);
  });

  it('keeps first mutation busy while rejecting a concurrent action from another UI path', async () => {
    const disabled = deferred<PluginListEntry>();
    const disablePlugin = vi.fn().mockReturnValue(disabled.promise);
    const approvePlugin = vi.fn();
    const client = clientWith([
      plugin(),
      plugin({name: 'needs-review', label: 'Needs Review', approval: 'pending', enabled: false}),
    ]);

    client.disablePlugin = disablePlugin;
    client.approvePlugin = approvePlugin;

    const {component, target} = await mountManager(client);
    const toggle = target.querySelector<HTMLButtonElement>('.mndw-installed__toggle');

    toggle?.click();
    await vi.waitFor(() => expect(disablePlugin).toHaveBeenCalledWith('network-tools'));
    expect(toggle?.disabled).toBe(true);

    const approve = target.querySelector<HTMLButtonElement>('.mndw-pending__approve');

    approve?.removeAttribute('disabled');
    approve?.click();
    await Promise.resolve();

    expect(approvePlugin).not.toHaveBeenCalled();
    expect(toggle?.disabled).toBe(true);

    disabled.resolve(plugin({enabled: false}));
    await vi.waitFor(() => expect(client.listPlugins.mock.calls).toHaveLength(2));
    await vi.waitFor(() => expect(toggle?.disabled).toBe(false));

    void unmount(component);
  });

  it('refreshes after a failed mutation and shows its error on matching row', async () => {
    const client = clientWith([plugin()]);

    client.disablePlugin.mockRejectedValue(new Error('Disable failed'));

    const {component, target} = await mountManager(client);

    client.listPlugins.mockClear();

    target.querySelector<HTMLButtonElement>('.mndw-installed__toggle')?.click();
    await vi.waitFor(() => expect(client.listPlugins.mock.calls).toHaveLength(1));

    expect(target.querySelector('.mndw-alert--danger')?.textContent).toContain('Disable failed');
    expect(target.querySelector('.mndw-reload')).toBeNull();

    void unmount(component);
  });

  it('approves a plugin and offers reload after refreshing', async () => {
    const client = clientWith([plugin({approval: 'pending', enabled: false})]);
    const {component, target} = await mountManager(client);

    client.listPlugins.mockClear();

    target.querySelector<HTMLButtonElement>('.mndw-pending__approve')?.click();
    await vi.waitFor(() => expect(client.approvePlugin.mock.calls).toContainEqual(['network-tools']));
    await vi.waitFor(() => expect(client.listPlugins.mock.calls).toHaveLength(1));

    expect(target.querySelector('.mndw-reload')).not.toBeNull();

    void unmount(component);
  });

  it('shows failed approval on pending row after refreshing', async () => {
    const client = clientWith([plugin({approval: 'pending', enabled: false})]);

    client.approvePlugin.mockRejectedValue(new Error('Approval failed'));

    const {component, target} = await mountManager(client);

    client.listPlugins.mockClear();

    target.querySelector<HTMLButtonElement>('.mndw-pending__approve')?.click();
    await vi.waitFor(() => expect(client.listPlugins.mock.calls).toHaveLength(1));

    expect(target.querySelector('.mndw-alert--danger')?.textContent).toContain('Approval failed');
    expect(target.querySelector('.mndw-reload')).toBeNull();

    void unmount(component);
  });

  it('confirms denial, refreshes, and does not offer reload', async () => {
    const client = clientWith([plugin({approval: 'pending', enabled: false})]);
    const {component, target} = await mountManager(client);

    client.listPlugins.mockClear();

    target.querySelector<HTMLButtonElement>('.mndw-pending__deny')?.click();
    flushSync();
    expect(target.querySelector('.mndw-pending__confirm')).not.toBeNull();
    target.querySelector<HTMLButtonElement>('.mndw-pending__confirm')?.click();
    await vi.waitFor(() => expect(client.denyPlugin.mock.calls).toContainEqual(['network-tools']));
    await vi.waitFor(() => expect(client.listPlugins.mock.calls).toHaveLength(1));

    expect(target.querySelector('.mndw-reload')).toBeNull();

    void unmount(component);
  });
});
