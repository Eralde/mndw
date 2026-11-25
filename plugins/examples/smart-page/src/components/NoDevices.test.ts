import {readFileSync} from 'node:fs';
import {flushSync, mount, settled, unmount} from 'svelte';
import {createTestI18n} from '@mndw/sdk/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import enCatalog from '../../i18n/en.json';
import type {Snapshot} from '../model/api';
import type {EmptyState, PageState} from '../services/page-controller';
import type {UsbInfoMap} from '../services/usb-info';
import NoDevices from './NoDevices.svelte';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLElement;

async function render(
  emptyState: EmptyState | null,
  usbInfo: UsbInfoMap = new Map(),
  overrides: Partial<PageState> = {},
  onDiscover = vi.fn().mockResolvedValue('accepted'),
): Promise<void> {
  const snapshot = JSON.parse(readFileSync('backend/testdata/wire/snapshot.golden.json', 'utf8')) as Snapshot;

  snapshot.devices = [];
  host = document.createElement('div');
  document.body.append(host);
  app = mount(NoDevices, {
    target: host,
    props: {
      state: {selectedDeviceId: null, snapshot, operation: null, backendAvailability: 'available', notice: null,
        wakeConsentGranted: false, wakeConsentKeys: new Set(), wakeConfirmationRequired: false, emptyState,
        ...overrides},
      i18n: createTestI18n(enCatalog),
      usbInfo,
      onDiscover,
    },
  });
  await settled();
  flushSync();
}

afterEach(() => {
  if (app !== null) {
    void unmount(app);
    app = null;
  }

  host?.remove();
});

describe('NoDevices', () => {
  it.each<[string, EmptyState | null, string, string | null]>([
    ['never-ran', {kind: 'never-ran'}, 'Find devices to scan connected storage.', 'Find devices'],
    ['nothing-found', {kind: 'nothing-found'}, 'No drives found', 'Search again'],
    ['failed', {kind: 'failed', code: 'request-failed'}, 'The request failed. Try again later.', 'Search again'],
    ['no-utility', {kind: 'no-utility'}, 'smartmontools package from Entware', null],
  ])('explains %s and offers the matching action', async (kind, emptyState, text, button) => {
    await render(emptyState);

    expect(host.querySelector('[data-testid="no-devices"]')?.getAttribute('data-kind')).toBe(
      emptyState?.kind ?? 'never-ran',
    );
    expect(host.textContent, kind).toContain(text);

    const discover = host.querySelector('[data-testid="discover"]');

    expect(discover?.textContent ?? null).toBe(button);
  });

  it('only waits, with the backend status, until the first snapshot has arrived', async () => {
    await render(null, new Map(), {snapshot: null, backendAvailability: 'unavailable'});

    expect(host.querySelector('[data-testid="no-devices"]')?.getAttribute('data-kind')).toBe('loading');
    expect(host.querySelector('[data-testid="backend-status"]')?.textContent).toContain('temporarily unavailable');
    expect(host.querySelector('[data-testid="discover"]')).toBeNull();
    expect(host.textContent).not.toContain('No devices');
  });

  it('announces the search result in a polite live region', async () => {
    await render({kind: 'nothing-found'});

    const region = host.querySelector('[role="status"][aria-live="polite"].result');

    expect(region?.textContent).toContain('No drives found');
  });

  it('runs a new search from the button', async () => {
    const onDiscover = vi.fn().mockResolvedValue('accepted');

    await render({kind: 'nothing-found'}, new Map(), {}, onDiscover);
    host.querySelector<HTMLElement>('[data-testid="discover"]')?.click();

    expect(onDiscover).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('names a USB disk that smartctl did not detect, with or without a port', async () => {
    await render(
      {kind: 'nothing-found'},
      new Map([
        ['/dev/sda', {manufacturer: 'Samsung', product: 'PSSD T7', port: '1', usbVersion: null, sizeBytes: null}],
        ['/dev/sdb', {manufacturer: null, product: null, port: null, usbVersion: null, sizeBytes: null}],
      ]),
    );

    expect(host.querySelector('[data-testid="undetected-/dev/sda"]')?.textContent).toContain(
      'Samsung PSSD T7 is connected via USB (port 1), but smartctl did not detect it',
    );
    expect(host.querySelector('[data-testid="undetected-/dev/sdb"]')?.textContent).toContain(
      '/dev/sdb is connected via USB, but smartctl did not detect it',
    );
  });

  it('keeps the search button disabled on a terminal backend', async () => {
    await render({kind: 'nothing-found'}, new Map(), {backendAvailability: 'not-approved'});

    expect(host.querySelector('[data-testid="discover"]')?.hasAttribute('disabled')).toBe(true);
    expect(host.querySelector('[data-testid="backend-status"]')?.textContent).toContain('not been approved');
  });
});
