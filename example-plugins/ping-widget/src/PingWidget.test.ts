// @vitest-environment happy-dom
import {flushSync, mount, settled, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import PingWidget from './PingWidget.svelte';

interface MockFetchOptions {
  body?: unknown;
}

interface MockHostUpdate {
  action: 'add' | 'remove' | 'update';
  ip: string;
  name?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

let mountedApps: Array<ReturnType<typeof mount>> = [];

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: (value: T) => resolvePromise(value),
    reject: (error: unknown) => rejectPromise(error),
  };
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

function hostStats(ip: string, name?: string) {
  return {
    ip,
    name,
    lastMs: 1.2,
    avgMs: 1.3,
    medianMs: 1.1,
    minMs: 1,
    maxMs: 1.8,
    lossPercent: 0,
    sampleCount: 4,
    updatedAt: '2026-07-14T10:00:00.000Z',
  };
}

function backendWithHosts(initialHosts: Array<{ip: string; name?: string}>) {
  let hosts = initialHosts.map((host) => ({...host}));
  let stats = hosts.map((host) => hostStats(host.ip, host.name));
  const updateBodies: MockHostUpdate[] = [];
  const queuedUpdates: Array<Promise<Response>> = [];

  const fetchMock = vi.fn((id: string, options?: MockFetchOptions) => {
    if (id === 'stats') {
      return Promise.resolve(response({success: true, data: stats}));
    }

    if (id === 'hosts') {
      return Promise.resolve(response({success: true, data: hosts}));
    }

    if (id === 'hostsUpdate') {
      const body = options?.body as MockHostUpdate;

      updateBodies.push(body);

      if (body.action === 'update') {
        hosts = hosts.map((host) => host.ip === body.ip ? {...host, name: body.name} : host);
        stats = stats.map((row) => row.ip === body.ip ? {...row, name: body.name} : row);
      }

      if (body.action === 'remove') {
        hosts = hosts.filter((host) => host.ip !== body.ip);
        stats = stats.filter((row) => row.ip !== body.ip);
      }

      return queuedUpdates.shift() ?? Promise.resolve(response({success: true, data: hosts}));
    }

    return Promise.resolve(response({success: true, data: []}));
  });

  return {
    backend: {fetch: fetchMock} as unknown as BackendClient,
    fetchMock,
    updateBodies,
    queueUpdate: (update: Promise<Response>) => queuedUpdates.push(update),
    currentHostsResponse: () => response({success: true, data: hosts}),
  };
}

async function mountWithHosts(
  target: HTMLElement,
  backend: BackendClient,
  ips: string[],
): Promise<ReturnType<typeof mount<typeof PingWidget>>> {
  const app = mount(PingWidget, {target, props: {backend}});

  mountedApps.push(app);

  flushSync();
  await vi.waitFor(async () => {
    await settled();
    flushSync();

    for (const ip of ips) {
      expect(target.textContent).toContain(ip);
    }
  });
  await settled();

  return app;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', {bubbles: true}));
  flushSync();
}

function pressKey(element: HTMLElement, key: string): void {
  element.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key}));
  flushSync();
}

function backendReturning(byId: Record<string, unknown>) {
  const fetchMock = vi.fn((id: string) =>
    Promise.resolve(
      new Response(JSON.stringify({success: true, data: byId[id] ?? []}), {
        headers: {'content-type': 'application/json'},
      }),
    )
  );

  return {backend: {fetch: fetchMock} as unknown as BackendClient, fetchMock};
}

describe('PingWidget', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(async () => {
    for (const app of mountedApps) {
      await unmount(app);
    }

    mountedApps = [];
    host.remove();
  });

  it('renders "unavailable" when backend is undefined', async () => {
    const app = mount(PingWidget, {target: host, props: {backend: undefined}});

    flushSync();

    expect(host.textContent).toMatch(/unavailable/i);
    await unmount(app);
  });

  it('loads stats and hosts on mount', async () => {
    const {backend, fetchMock} = backendReturning({
      stats: [hostStats('9.9.9.9', 'dns')],
      hosts: [{ip: '9.9.9.9', name: 'dns'}],
    });
    const app = mount(PingWidget, {target: host, props: {backend}});

    flushSync();

    await vi.waitFor(async () => {
      await settled();
      flushSync();
      expect(host.textContent).toContain('9.9.9.9');
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Data refreshed');
    });
    await settled();

    expect(fetchMock).toHaveBeenCalledWith('stats');
    expect(fetchMock).toHaveBeenCalledWith('hosts');
    await unmount(app);
  });

  it('renames a host from its stats-table cell', async () => {
    const {backend, updateBodies} = backendWithHosts([{ip: '9.9.9.9', name: 'dns'}]);

    await mountWithHosts(host, backend, ['9.9.9.9']);

    const renameButton = host.querySelector('[aria-label="Rename host 9.9.9.9"]');

    expect(renameButton).not.toBeNull();
    renameButton?.click();
    flushSync();

    const input = host.querySelector('[aria-label="Label for 9.9.9.9"]');

    expect(input).not.toBeNull();

    if (input) {
      setInputValue(input, 'public dns');
      pressKey(input, 'Enter');
    }

    await vi.waitFor(() => {
      expect(updateBodies).toContainEqual({action: 'update', ip: '9.9.9.9', name: 'public dns'});
    });
  });

  it('saves an inline rename when the editor loses focus', async () => {
    const {backend, updateBodies} = backendWithHosts([{ip: '9.9.9.9', name: 'dns'}]);

    await mountWithHosts(host, backend, ['9.9.9.9']);
    host.querySelector('[aria-label="Rename host 9.9.9.9"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    flushSync();

    const input = host.querySelector('[aria-label="Label for 9.9.9.9"]');

    expect(input).not.toBeNull();

    if (input) {
      setInputValue(input, 'gateway dns');
      input.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
      flushSync();
    }

    await vi.waitFor(() => {
      expect(updateBodies).toContainEqual({action: 'update', ip: '9.9.9.9', name: 'gateway dns'});
    });
  });

  it('saves an empty label and falls back to the host IP', async () => {
    const {backend, updateBodies} = backendWithHosts([{ip: '9.9.9.9', name: 'dns'}]);

    await mountWithHosts(host, backend, ['9.9.9.9']);
    host.querySelector('[aria-label="Rename host 9.9.9.9"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    flushSync();

    const input = host.querySelector('[aria-label="Label for 9.9.9.9"]');

    expect(input).not.toBeNull();

    if (input) {
      setInputValue(input, '');
      pressKey(input, 'Enter');
    }

    await vi.waitFor(() => {
      expect(updateBodies).toContainEqual({action: 'update', ip: '9.9.9.9', name: ''});
    });
    await vi.waitFor(() => {
      const row = host.querySelector('tbody tr');

      expect(row?.querySelector('.host-label')?.textContent).toBe('9.9.9.9');
      expect(row?.querySelector('.host-address')).toBeNull();
    });
  });

  it('cancels an inline rename without writing it', async () => {
    const {backend, updateBodies} = backendWithHosts([{ip: '9.9.9.9', name: 'dns'}]);

    await mountWithHosts(host, backend, ['9.9.9.9']);
    host.querySelector('[aria-label="Rename host 9.9.9.9"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    flushSync();

    const input = host.querySelector('[aria-label="Label for 9.9.9.9"]');

    expect(input).not.toBeNull();

    if (input) {
      setInputValue(input, 'temporary');
      pressKey(input, 'Escape');
    }

    expect(updateBodies).toHaveLength(0);
    expect(host.textContent).toContain('dns');
    expect(host.querySelector('[aria-label="Label for 9.9.9.9"]')).toBeNull();
  });

  it('keeps a failed rename draft visible with an inline error', async () => {
    const {backend, updateBodies, queueUpdate} = backendWithHosts([{ip: '9.9.9.9', name: 'dns'}]);

    queueUpdate(Promise.resolve(response({success: false, message: 'Rename failed'}, 500)));
    await mountWithHosts(host, backend, ['9.9.9.9']);
    host.querySelector('[aria-label="Rename host 9.9.9.9"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    flushSync();

    const input = host.querySelector('[aria-label="Label for 9.9.9.9"]');

    expect(input).not.toBeNull();

    if (input) {
      setInputValue(input, 'broken rename');
      pressKey(input, 'Enter');
    }

    await vi.waitFor(() => {
      expect(updateBodies).toContainEqual({action: 'update', ip: '9.9.9.9', name: 'broken rename'});
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('Rename failed');
      expect((host.querySelector('[aria-label="Label for 9.9.9.9"]'))?.value).toBe(
        'broken rename',
      );
    });
  });

  it('allows another host to be edited while one rename is saving', async () => {
    const {backend, updateBodies, queueUpdate, currentHostsResponse} = backendWithHosts([
      {ip: '9.9.9.9', name: 'dns'},
      {ip: '1.1.1.1', name: 'resolver'},
    ]);
    const firstUpdate = deferred<Response>();
    const secondUpdate = deferred<Response>();

    queueUpdate(firstUpdate.promise);
    queueUpdate(secondUpdate.promise);
    await mountWithHosts(host, backend, ['9.9.9.9', '1.1.1.1']);

    host.querySelector('[aria-label="Rename host 9.9.9.9"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    flushSync();

    const firstInput = host.querySelector('[aria-label="Label for 9.9.9.9"]');

    expect(firstInput).not.toBeNull();

    if (firstInput) {
      setInputValue(firstInput, 'primary dns');
      pressKey(firstInput, 'Enter');
    }

    await vi.waitFor(() => {
      expect(updateBodies).toHaveLength(1);
      expect(host.querySelector('[role="status"]')?.textContent).toContain('Saving');
    });

    host.querySelector('[aria-label="Rename host 1.1.1.1"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    flushSync();

    const secondInput = host.querySelector('[aria-label="Label for 1.1.1.1"]');

    expect(secondInput).not.toBeNull();

    if (secondInput) {
      expect((host.querySelector('[aria-label="Label for 9.9.9.9"]'))?.disabled).toBe(true);
      expect(secondInput.disabled).toBe(false);
      setInputValue(secondInput, 'secondary dns');
      pressKey(secondInput, 'Enter');
    }

    await vi.waitFor(() => {
      expect(updateBodies).toHaveLength(2);
      expect((host.querySelector('[aria-label="Label for 9.9.9.9"]'))?.disabled).toBe(true);
      expect((host.querySelector('[aria-label="Label for 1.1.1.1"]'))?.disabled).toBe(true);
    });

    firstUpdate.resolve(currentHostsResponse());
    secondUpdate.resolve(currentHostsResponse());
    await settled();
  });

  it('removes a host from its stats-table cell', async () => {
    const {backend, updateBodies} = backendWithHosts([{ip: '9.9.9.9', name: 'dns'}]);

    await mountWithHosts(host, backend, ['9.9.9.9']);

    host.querySelector('[aria-label="Remove host 9.9.9.9"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await vi.waitFor(() => {
      expect(updateBodies).toContainEqual({action: 'remove', ip: '9.9.9.9'});
    });
  });
});
