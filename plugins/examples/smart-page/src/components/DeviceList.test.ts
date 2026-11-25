import {readFileSync} from 'node:fs';
import {flushSync, mount, settled, unmount} from 'svelte';
import {createTestI18n} from '@mndw/sdk/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import enCatalog from '../../i18n/en.json';
import ruCatalog from '../../i18n/ru.json';
import type {Operation, Snapshot} from '../model/api';
import type {ActionResult, PageState} from '../services/page-controller';
import type {UsbInfoMap} from '../services/usb-info';
import DeviceList from './DeviceList.svelte';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLElement;

function makeState(overrides: Partial<PageState> = {}): PageState {
  const snapshot = JSON.parse(readFileSync('backend/testdata/wire/snapshot.golden.json', 'utf8')) as Snapshot;

  return {
    selectedDeviceId: snapshot.devices[0]?.deviceId ?? null,
    snapshot,
    operation: null,
    backendAvailability: 'available',
    notice: null,
    wakeConsentGranted: false,
    wakeConsentKeys: new Set(),
    wakeConfirmationRequired: false,
    emptyState: null,
    ...overrides,
  };
}

const formatted = (value: string): string => {
  return new Intl.DateTimeFormat('en', {dateStyle: 'medium', timeStyle: 'medium'}).format(new Date(value));
};

async function render(
  state: PageState,
  onDiscover: (targetDeviceId: string | undefined) => Promise<ActionResult> = vi.fn().mockResolvedValue('accepted'),
  onSelect = vi.fn(),
  usbInfo: UsbInfoMap = new Map(),
  locale: 'en' | 'ru' = 'en',
): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  app = mount(DeviceList, {
    target: host,
    props: {
      state,
      i18n: createTestI18n(locale === 'ru' ? ruCatalog : enCatalog, locale),
      locale,
      usbInfo,
      onDiscover,
      onSelect,
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

describe('DeviceList', () => {
  it('discovery button runs immediately without a warning', async () => {
    const onDiscover = vi.fn().mockResolvedValue('accepted');

    await render(makeState(), onDiscover);
    host.querySelector<HTMLElement>('[data-testid="discover"]')?.click();
    await settled();
    flushSync();

    expect(onDiscover).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(host.textContent).not.toContain('can wake sleeping disks');
    expect(host.querySelector('[data-testid="confirm-discover"]')).toBeNull();
  });

  it('does not apply the full-width device card layout to the discover button', async () => {
    await render(makeState());

    const discover = host.querySelector<HTMLElement>('[data-testid="discover"]');
    const card = host.querySelector<HTMLElement>('[data-testid="device-dev-a"]');

    expect(discover?.classList.contains('device-card-button')).toBe(false);
    expect(card?.classList.contains('device-card-button')).toBe(true);
  });

  it('backend availability does not hide the card status', async () => {
    await render(makeState({backendAvailability: 'unavailable'}));

    expect(host.querySelector('[data-testid="backend-status"]')?.textContent).toContain('temporarily unavailable');
    expect(host.querySelector('[data-testid="health-dev-a"]')?.textContent).toContain('Passed');
  });

  it.each(
    [
      ['available', false],
      ['unknown', true],
      ['starting', true],
      ['unavailable', true],
      ['not-approved', true],
    ] as const,
  )('backend state %s shows a status line: %s', async (backendAvailability, shown) => {
    await render(makeState({backendAvailability}));

    expect(host.querySelector('[data-testid="backend-status"]') !== null).toBe(shown);
  });

  it('component disconnected selection and truncation notice', async () => {
    const state = makeState();

    if (state.snapshot === null) {
      throw new Error('fixture snapshot is missing');
    }

    state.snapshot = {
      ...state.snapshot,
      truncated: true,
      disconnectedTruncated: true,
      devices: state.snapshot.devices.map((device) => ({
        ...device,
        binding: 'disconnected',
        collection: {...device.collection, status: 'disconnected'},
      })),
    };

    const onSelect = vi.fn();

    await render(state, vi.fn(), onSelect);

    expect(host.textContent).toContain('Some devices are hidden');
    expect(host.textContent).toContain('Some disconnected devices are hidden');

    const card = host.querySelector<HTMLElement>('[data-testid="device-dev-a"]');

    expect(card?.getAttribute('aria-pressed')).toBe('true');
    expect(card?.textContent).toContain('›');
    card?.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('dev-a');
  });

  it('shows name, path, port, size and one status chip, and never the serial, temperature or last read', async () => {
    const state = makeState();
    const device = state.snapshot?.devices[0];

    if (device?.sample === null || device?.sample === undefined) { throw new Error('fixture sample is missing'); }

    device.sample.identity.serial = 'PRIVATE-SERIAL-987';
    device.sample.temperatureC = 42;
    device.freshness.lastSuccessAt = '2026-11-24T10:11:12Z';
    await render(
      state,
      undefined,
      undefined,
      new Map([['/dev/sda', {
        manufacturer: 'Samsung',
        product: 'PSSD T7',
        port: '1',
        usbVersion: null,
        sizeBytes: null,
      }]]),
    );

    const card = host.querySelector<HTMLElement>('[data-testid="device-dev-a"]');

    expect(card?.textContent).toContain('Samsung PSSD T7');
    expect(card?.textContent).toContain('/dev/sda · USB port 1 · 2 TB');
    expect(card?.querySelectorAll('.status-chip')).toHaveLength(1);
    expect(host.textContent).not.toContain('2000398934016');
    expect(host.textContent).not.toContain('42 °C');
    expect(host.textContent).not.toContain('Temperature');
    expect(host.textContent).not.toContain('Last successful read');
    expect(host.textContent).not.toContain(formatted('2026-11-24T10:11:12Z'));
    expect(host.textContent).not.toContain('PRIVATE-SERIAL-987');
  });

  it('writes the card size with the page locale\'s unit and decimal separator', async () => {
    const state = makeState();
    const sample = state.snapshot?.devices[0]?.sample;

    if (sample === null || sample === undefined) { throw new Error('fixture sample is missing'); }

    sample.identity.capacityBytes = '1500000000000';
    await render(state, undefined, undefined, undefined, 'ru');

    expect(host.querySelector('.device-path')?.textContent).toBe('/dev/sda · 1,5 ТБ');
  });

  it.each(
    [
      ['unknown', 'Passed'],
      ['warning', 'Passed · Warning'],
    ] as const,
  )('names a %s assessment level on the chip only when it adds something', async (level, text) => {
    const state = makeState();
    const sample = state.snapshot?.devices[0]?.sample;

    if (sample === null || sample === undefined) { throw new Error('fixture sample is missing'); }

    sample.assessment.level = level;
    await render(state);

    expect(host.querySelector('[data-testid="health-dev-a"]')?.textContent?.trim()).toBe(text);
  });

  it('shows the search progress in the panel, and leaves the list area empty while a search fills it', async () => {
    const state = makeState({emptyState: {kind: 'searching'}});

    if (state.snapshot === null) { throw new Error('fixture snapshot is missing'); }

    state.snapshot.devices = [];
    await render(state);

    const searching = host.querySelector('[data-testid="searching"]');

    expect(searching?.closest('[data-testid="discovery-panel"]')).not.toBeNull();
    expect(searching?.textContent).toContain('Searching for drives…');
    expect(host.querySelectorAll('mndw-progress')).toHaveLength(1);
    expect(host.querySelector('[data-testid="discover"]')?.hasAttribute('disabled')).toBe(true);
    expect(host.querySelector('ul')).toBeNull();
    expect(host.querySelector('.device-card-button')).toBeNull();
    expect(host.querySelectorAll('.device-list > *')).toHaveLength(2);
  });

  const scan = (
    status: Operation['status'],
    completedAt: string | null = null,
    kind: Operation['kind'] = 'discover',
  ) => ({schemaVersion: 1 as const, id: 'op-1', kind, deviceId: null, status, createdAt: '2026-11-24T11:59:00Z',
    completedAt, result: null, error: null});
  const done = '2026-11-24T11:59:57Z';
  const stamp = (locale: 'en' | 'ru'): string =>
    new Intl.DateTimeFormat(locale, {dateStyle: 'medium', timeStyle: 'medium'}).format(new Date(done));
  const noSearch = {en: 'No search yet', ru: 'Поиск ещё не выполнялся'};
  const searchingText = {en: 'Searching for drives…', ru: 'Ищем накопители…'};
  const failedText = {en: 'Search failed', ru: 'Поиск завершился ошибкой'};
  const doneText = {en: 'Search done', ru: 'Поиск выполнен'};
  const blank = {en: '', ru: ''};
  // The last column is what the snapshot says: it ran (the fixture), it never ran, or there is no snapshot yet.
  const panelStates = [
    ['first load, no snapshot', {}, 'unknown', blank, false, 'absent'],
    ['never ran', {}, 'none', noSearch, false, 'never-ran'],
    ['a reload: ran, no operation here', {}, 'succeeded', doneText, false, 'ran'],
    [
      'a refresh only, never ran',
      {operation: scan('succeeded', done, 'refresh')},
      'none',
      noSearch,
      false,
      'never-ran',
    ],
    ['a refresh only, ran', {operation: scan('succeeded', done, 'refresh')}, 'succeeded', doneText, false, 'ran'],
    ['canceled, never ran', {operation: scan('cancelled', done)}, 'none', noSearch, false, 'never-ran'],
    ['canceled, ran', {operation: scan('cancelled', done)}, 'succeeded', doneText, false, 'ran'],
    ['queued', {operation: scan('queued')}, 'running', searchingText, false, 'ran'],
    ['running', {operation: scan('running')}, 'running', searchingText, false, 'ran'],
    ['a scan with no operation', {emptyState: {kind: 'searching'}}, 'running', searchingText, false, 'ran'],
    [
      'succeeded',
      {operation: scan('succeeded', done)},
      'succeeded',
      {en: 'Last search:', ru: 'Последний поиск:'},
      true,
      'ran',
    ],
    ['succeeded without a time', {operation: scan('succeeded')}, 'succeeded', doneText, false, 'ran'],
    ['failed', {operation: scan('failed', done)}, 'failed', failedText, true, 'ran'],
    [
      'failed without a time',
      {emptyState: {kind: 'failed', code: 'request-failed'}},
      'failed',
      failedText,
      false,
      'ran',
    ],
  ] as const;

  it.each(
    panelStates.flatMap((row) => (['en', 'ru'] as const).map((locale) => [...row, locale] as const)),
  )('panel shows the %s status (%s) in %s', async (_name, overrides, kind, texts, withTime, snapshot, locale) => {
    const state = makeState(overrides as Partial<PageState>);

    if (snapshot === 'absent') {
      state.snapshot = null;
    } else if (snapshot === 'never-ran' && state.snapshot !== null) {
      state.snapshot.diagnostics.reasons = ['discovery-not-run'];
    }

    await render(state, undefined, undefined, undefined, locale);

    // The container is the same live region in every state, including the empty first load.
    const status = host.querySelector('[data-testid="discovery-status"]');

    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('data-state')).toBe(kind);
    expect(status?.textContent?.trim() ?? null).toSatisfy((text: string | null) =>
      kind === 'unknown' ? text === '' : text?.includes(texts[locale]) === true
    );
    expect(status?.querySelector('time')?.textContent ?? null).toBe(withTime ? stamp(locale) : null);
    expect(status?.querySelector('.status-failed')?.textContent).toBe(kind === 'failed' ? texts[locale] : undefined);
  });

  it('shows only the not-read chip when there is no sample', async () => {
    const state = makeState();

    if (state.snapshot?.devices[0] === undefined) { throw new Error('fixture device is missing'); }

    state.snapshot.devices[0].sample = null;
    await render(state);

    expect(host.textContent).toContain('Not read yet');
    expect(host.querySelector('[data-testid="health-dev-a"]')).toBeNull();
  });
});
