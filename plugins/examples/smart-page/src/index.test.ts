import {readFileSync} from 'node:fs';
import {settled} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient, PluginInstance} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import enCatalog from '../i18n/en.json';
import type {Snapshot} from './model/api';
import {createInstance} from './index';

let host: HTMLElement;
let instance: PluginInstance | null = null;

afterEach(async () => {
  await instance?.unmount();
  instance = null;
  host?.remove();
});

describe('createInstance', () => {
  it('does not surface or apply an aborted USB read after unmount', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    let signal: AbortSignal | undefined;
    const query = vi.fn((_requests: unknown, options?: {signal?: AbortSignal}) => {
      signal = options?.signal;

      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }, {once: true});
      });
    });
    const fixture = createTestPluginContext({kind: 'page', i18n: createTestI18n(enCatalog)});
    const context = {
      ...fixture.context,
      device: {
        ...fixture.context.device,
        rci: {...fixture.context.device.rci, query},
      },
    };

    process.on('unhandledRejection', onUnhandledRejection);
    host = document.createElement('div');
    document.body.append(host);

    try {
      instance = createInstance(host, context as unknown as typeof fixture.context);
      await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());

      await instance.unmount();
      instance = null;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(signal?.aborted).toBe(true);
      expect(unhandledRejections).toEqual([]);
      expect(host.textContent).toBe('');
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('reads USB metadata on mount and after automatic discovery', async () => {
    const snapshot = JSON.parse(
      readFileSync('backend/testdata/wire/snapshot.golden.json', 'utf8'),
    ) as Record<string, unknown>;

    const diagnostics = snapshot.diagnostics as Record<string, unknown>;

    diagnostics.reasons = ['discovery-not-run'];

    const fetch = vi.fn((route: string): Promise<Response> => {
      if (route === 'snapshot') {
        return Promise.resolve(new Response(JSON.stringify(snapshot), {status: 200}));
      }

      if (route === 'discover') {
        return Promise.resolve(new Response(JSON.stringify({schemaVersion: 1, operationId: 'op-1'}), {status: 202}));
      }

      if (route === 'operation') {
        return Promise.resolve(
          new Response(JSON.stringify({schemaVersion: 1, error: {code: 'unknown-operation'}}), {status: 404}),
        );
      }

      throw new Error(`unexpected backend route: ${route}`);
    });

    const query = vi.fn().mockResolvedValue([
      {device: {Media0: {
        DEVPATH: '/devices/platform/usb/block/sda',
        manufacturer: 'Samsung',
        product: 'PSSD T7',
        port: '1',
      }}},
      {device: {Media0: {
        bus: 'usb',
        manufacturer: 'Samsung',
        product: 'PSSD T7',
        size: '2000398934016',
        usb: {port: 1, version: '3.20'},
      }}},
    ]);
    const fixture = createTestPluginContext({
      kind: 'page',
      i18n: createTestI18n({...enCatalog, 'discovery-not-run': 'Discovery has not run yet.'}),
    });
    const context = {
      ...fixture.context,
      backend: {fetch} as unknown as BackendClient,
      device: {
        ...fixture.context.device,
        rci: {...fixture.context.device.rci, query},
      },
    };

    host = document.createElement('div');
    document.body.append(host);

    instance = createInstance(host, context as unknown as typeof fixture.context);

    expect(host.querySelector('h1')).not.toBeNull();
    // The host owns the page's main landmark.
    expect(host.querySelector('main')).toBeNull();
    await vi.waitFor(() => expect(host.textContent).toContain('Discovery has not run yet.'));
    await vi.waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(1));
    await vi.waitFor(() => expect(fetch.mock.calls.some(([route]) => route === 'discover')).toBe(true));
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(host.textContent).toContain('Samsung PSSD T7');
    expect(host.textContent).toContain('2 TB');
    await instance.unmount();
    instance = null;
    expect(host.childElementCount).toBe(0);
  });

  it.each([
    ['busy', 'Another device operation is in progress.'],
    ['disconnected', 'This device is disconnected. Find devices to scan again.'],
  ])('renders a %s notice once after a rejected operation', async (errorCode, message) => {
    const snapshot = JSON.parse(
      readFileSync('backend/testdata/wire/snapshot.golden.json', 'utf8'),
    ) as Record<string, unknown>;
    const fetch = vi.fn((route: string): Promise<Response> => {
      if (route === 'snapshot') {
        return Promise.resolve(new Response(JSON.stringify(snapshot), {status: 200}));
      }

      if (route === 'discover') {
        return Promise.resolve(
          new Response(JSON.stringify({schemaVersion: 1, error: {code: errorCode}}), {status: 409}),
        );
      }

      throw new Error(`unexpected backend route: ${route}`);
    });
    const fixture = createTestPluginContext({kind: 'page', i18n: createTestI18n(enCatalog)});
    const context = {...fixture.context, backend: {fetch} as unknown as BackendClient};

    host = document.createElement('div');
    document.body.append(host);
    instance = createInstance(host, context as unknown as typeof fixture.context);

    await vi.waitFor(() => expect(host.querySelector('[data-testid="discover"]')).not.toBeNull());
    host.querySelector<HTMLElement>('[data-testid="discover"]')?.click();
    await settled();
    await vi.waitFor(() => expect(host.textContent).toContain(message));

    expect(host.querySelectorAll('[data-testid="page-notice"]')).toHaveLength(1);
    expect(host.textContent?.split(message)).toHaveLength(2);
  });

  describe('master-detail layout', () => {
    const wire = (): Snapshot =>
      JSON.parse(readFileSync('backend/testdata/wire/snapshot.golden.json', 'utf8')) as Snapshot;
    const twoDrives = (): Snapshot => {
      const value = wire();
      const first = value.devices[0];

      if (first === undefined) { throw new Error('fixture device is missing'); }

      value.devices.push({...structuredClone(first), deviceId: 'dev-b', path: '/dev/sdb'});

      return value;
    };

    async function mountPage(
      snapshot: Snapshot,
      routes: Record<string, () => Promise<Response>> = {},
      query?: ReturnType<typeof vi.fn>,
    ): Promise<void> {
      const fetch = vi.fn((route: string): Promise<Response> => {
        const handler = routes[route];

        if (handler !== undefined) { return handler(); }

        if (route === 'snapshot') {
          return Promise.resolve(new Response(JSON.stringify(snapshot), {status: 200}));
        }

        throw new Error(`unexpected backend route: ${route}`);
      });
      const fixture = createTestPluginContext({kind: 'page', i18n: createTestI18n(enCatalog)});
      const context = {
        ...fixture.context,
        backend: {fetch} as unknown as BackendClient,
        device: {...fixture.context.device, rci: {...fixture.context.device.rci, query: query ?? vi.fn()}},
      };

      host = document.createElement('div');
      document.body.append(host);
      instance = createInstance(host, context as unknown as typeof fixture.context);
      await vi.waitFor(() => expect(host.querySelector('[data-testid="diagnostics"]')).not.toBeNull());
    }

    const view = (): string | null | undefined =>
      host.querySelector('[data-testid="layout"]')?.getAttribute('data-view');
    const card = (deviceId: string): HTMLElement => {
      const element = host.querySelector<HTMLElement>(`[data-testid="device-${deviceId}"]`);

      if (element === null) { throw new Error(`card ${deviceId} is missing`); }

      return element;
    };
    const click = async (testId: string): Promise<void> => {
      host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();
      await settled();
    };

    it('opens a single drive directly, and back returns to the list with focus on its card', async () => {
      await mountPage(wire());
      await vi.waitFor(() => expect(view()).toBe('details'));
      expect(host.querySelector('#details-title')?.textContent).toBe('ACME HDD 2TB');

      const focusCard = vi.spyOn(card('dev-a'), 'focus');

      await click('back-to-list');

      expect(view()).toBe('list');
      await vi.waitFor(() => expect(focusCard).toHaveBeenCalledOnce());

      await click('device-dev-a');

      expect(view()).toBe('details');
      await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('#details-title')));
    });

    it('starts at the list for several drives and opens the chosen one', async () => {
      await mountPage(twoDrives());
      await vi.waitFor(() => expect(host.querySelectorAll('.device-card-button')).toHaveLength(2));
      expect(view()).toBe('list');

      const focusCard = vi.spyOn(card('dev-b'), 'focus');

      await click('device-dev-b');

      expect(view()).toBe('details');
      expect(host.querySelector('[data-testid="device-dev-b"]')?.getAttribute('aria-pressed')).toBe('true');
      await click('back-to-list');
      expect(view()).toBe('list');
      await vi.waitFor(() => expect(focusCard).toHaveBeenCalledOnce());
    });

    it('places diagnostics below both columns inside a closed details element', async () => {
      await mountPage(wire());

      const diagnostics = host.querySelector('details[data-testid="diagnostics"]');
      const layout = host.querySelector('[data-testid="layout"]');

      expect(diagnostics).not.toBeNull();
      expect(diagnostics?.hasAttribute('open')).toBe(false);
      expect(diagnostics?.closest('.list-column, .detail-column')).toBeNull();
      expect(layout?.contains(diagnostics ?? null)).toBe(false);
      expect(layout?.nextElementSibling).toBe(diagnostics);
    });

    it('keeps both columns while the first search runs, with a placeholder and no read button', async () => {
      const value = wire();

      value.devices = [];
      value.diagnostics.reasons = ['discovery-not-run'];
      await mountPage(value, {discover: () => new Promise<Response>(() => {})});

      await vi.waitFor(() => expect(host.querySelector('[data-testid="searching"]')).not.toBeNull());
      expect(host.querySelector('[data-testid="layout"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="discover"]')?.hasAttribute('disabled')).toBe(true);
      expect(host.querySelector('.detail-column')?.textContent).toContain('Drive details appear here');
      expect(host.querySelector('[data-testid="refresh"]')).toBeNull();
      expect(view()).toBe('list');
    });

    it('shows one centered block for an empty result, naming a USB disk smartctl missed', async () => {
      const value = wire();
      const query = vi.fn().mockResolvedValue([
        {device: {Media0: {DEVPATH: '/devices/usb/block/sdb'}}},
        {device: {Media0: {bus: 'usb', manufacturer: 'WD', product: 'Elements', usb: {port: 2}}}},
      ]);

      value.devices = [];
      await mountPage(value, {}, query);

      await vi.waitFor(() => expect(host.textContent).toContain('WD Elements is connected via USB (port 2)'));
      expect(host.querySelector('[data-testid="layout"]')).toBeNull();
      expect(host.querySelector('[data-testid="no-devices"]')?.getAttribute('data-kind')).toBe('nothing-found');
      expect(host.querySelector('details[data-testid="diagnostics"]')?.hasAttribute('open')).toBe(false);
      expect(host.querySelector('.single-column details[data-testid="diagnostics"]')).not.toBeNull();
    });

    const finishedScan = {schemaVersion: 1, id: 'op-1', kind: 'discover', deviceId: null, status: 'succeeded',
      createdAt: '2026-11-24T11:59:00Z', completedAt: '2026-11-24T11:59:05Z', error: null,
      result: {kind: 'discover', deviceIds: [], truncated: false, exitCode: 0}};
    const json = (value: unknown, status = 200) => (): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify(value), {status}));

    it('moves focus with a search that swaps the centered block for the list and back', async () => {
      const value = wire();
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });

      value.devices = [];
      await mountPage(value, {
        discover: json({schemaVersion: 1, operationId: 'op-1'}, 202),
        operation: () => finished.then(json(finishedScan)),
      });

      const button = host.querySelector<HTMLElement>('[data-testid="discover"]');

      button?.focus();
      button?.click();
      await vi.waitFor(() => expect(host.querySelector('[data-testid="searching"]')).not.toBeNull());
      await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('#devices-title')));

      finish();
      await vi.waitFor(() => expect(host.querySelector('[data-testid="no-devices"]')).not.toBeNull());
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(host.querySelector('[data-testid="no-devices"] #devices-title'))
      );
    });

    it('moves focus to the details when a search finds exactly one drive while focus is in the list', async () => {
      let current = wire();
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });

      current.devices = [];
      await mountPage(current, {
        snapshot: () => json(current)(),
        discover: json({schemaVersion: 1, operationId: 'op-1'}, 202),
        operation: () => finished.then(json(finishedScan)),
      });

      const button = host.querySelector<HTMLElement>('[data-testid="discover"]');

      button?.focus();
      button?.click();
      await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('#devices-title')));

      current = wire();
      finish();
      await vi.waitFor(() => expect(view()).toBe('details'));
      await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('#details-title')));
    });

    it('does not reopen the details of a drive that left the snapshot and came back', async () => {
      let current = twoDrives();
      const discoverEnabled = (): boolean =>
        host.querySelector('[data-testid="discover"]')?.hasAttribute('disabled') === false;

      await mountPage(current, {
        snapshot: () => json(current)(),
        discover: json({schemaVersion: 1, operationId: 'op-1'}, 202),
        operation: json(finishedScan),
      });
      await click('device-dev-b');
      expect(view()).toBe('details');

      current = wire();
      await click('discover');
      await vi.waitFor(() => expect(host.querySelectorAll('.device-card-button')).toHaveLength(1));
      await vi.waitFor(() => expect(discoverEnabled()).toBe(true));
      expect(view()).toBe('list');

      current = twoDrives();
      await click('discover');
      await vi.waitFor(() => expect(host.querySelectorAll('.device-card-button')).toHaveLength(2));
      expect(view()).toBe('list');
    });
  });
});
