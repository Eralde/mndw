// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PluginContext, RciQuery} from '@mndw/sdk';
import type {MndwTable} from '@mndw/ui';
import {type TestPluginContext, createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {Observable, of, throwError} from 'rxjs';
import {type App as VueApp, createApp, nextTick} from 'vue';
import fixture from './fixtures/show-device-list.json' with {type: 'json'};
import type {ClientRecord} from './services/clients.js';
import {openSettingsDialog} from './services/open-settings-dialog.js';
import App from './App.vue';
import enCatalog from '../i18n/en.json';

vi.mock('./services/open-settings-dialog.js', () => ({
  openSettingsDialog: vi.fn(),
}));

let host: HTMLElement;
let app: VueApp | null = null;
let queue: ReturnType<typeof vi.fn>;
let store: Map<string, string>;
let storageGet: ReturnType<typeof vi.fn>;
let storageSet: ReturnType<typeof vi.fn>;
let overlayOpen: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
let setTileTitle: ReturnType<typeof vi.fn>;
const pluginContextFixtures: TestPluginContext[] = [];

function createContext(i18n = createTestI18n(enCatalog)): PluginContext {
  const fixtureContext = createTestPluginContext({i18n, device: {rci: {queue: queue as never}}});

  pluginContextFixtures.push(fixtureContext);

  return {
    kind: 'widget',
    setTileTitle,
    device: {rci: fixtureContext.context.device.rci},
    storage: {
      instance: {
        get: storageGet,
        set: storageSet,
        delete: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
      },
      shared: {get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn()},
    },
    overlay: {open: overlayOpen, createLayer: vi.fn(), closeAll: vi.fn()},
    i18n,
    timers: fixtureContext.context.timers,
  } as unknown as PluginContext;
}

function unmountPluginContextFixtures(): void {
  for (const pluginContextFixture of pluginContextFixtures) {
    pluginContextFixture.unmount();
  }
}

function mountWidget(i18n = createTestI18n(enCatalog)): void {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(App, {ctx: createContext(i18n)});
  app.mount(host);
}

function text(): string {
  return host.textContent ?? '';
}

function tableEl(): MndwTable<ClientRecord> | null {
  return host.querySelector<MndwTable<ClientRecord>>('mndw-table');
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }

  await tableEl()?.updateComplete;
}

function tableShadow(): ShadowRoot {
  const shadow = tableEl()?.shadowRoot;

  if (shadow === null || shadow === undefined) {
    throw new Error('mndw-table has no shadow root');
  }

  return shadow;
}

function rowNames(): string[] {
  return (tableEl()?.rows ?? []).map((row) => row.displayName);
}

function headers(): string[] {
  return [...tableShadow().querySelectorAll('[part~="header-cell"]')]
    .map((cell) => cell.textContent?.trim() ?? '')
    .filter((label) => label !== '');
}

type MndwCheckboxHost = HTMLElement & {checked: boolean};

function offlineToggle(): MndwCheckboxHost {
  const input = host.querySelector<MndwCheckboxHost>('header mndw-checkbox');

  if (input === null) {
    throw new Error('no Show offline toggle');
  }

  return input;
}

function setOffline(value: boolean): void {
  const toggle = offlineToggle();

  toggle.checked = value;
  toggle.dispatchEvent(
    new CustomEvent('mndwchange', {
      bubbles: true,
      composed: true,
      detail: {checked: value, indeterminate: false},
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  queue = vi.fn((_query: RciQuery): Observable<unknown> => of(fixture));
  store = new Map();
  storageGet = vi.fn((key: string) => Promise.resolve(store.get(key) ?? null));
  storageSet = vi.fn((key: string, value: string) => {
    store.set(key, value);

    return Promise.resolve();
  });
  overlayOpen = vi.fn();
  setTileTitle = vi.fn();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(openSettingsDialog).mockClear();
});

afterEach(() => {
  app?.unmount();
  app = null;
  unmountPluginContextFixtures();
  pluginContextFixtures.length = 0;
  host?.remove();
  warn.mockRestore();
  vi.useRealTimers();
});

describe('initial render', () => {
  it('shows the loading copy and a bare header before the first response', () => {
    queue = vi.fn(() => new Observable<unknown>(() => {}));
    mountWidget();

    expect(text()).toContain('Loading clients…');
    expect(host.querySelector('.clients-widget__header > span')).toBeNull();
    expect(setTileTitle).toHaveBeenLastCalledWith('Clients');
  });

  it('keeps header visible while widget content scrolls', () => {
    mountWidget();

    const widget = host.querySelector<HTMLElement>('.clients-widget');
    const header = host.querySelector<HTMLElement>('.clients-widget__header');

    if (widget === null || header === null) {
      throw new Error('widget header was not rendered');
    }

    expect(getComputedStyle(widget).overflow).toBe('hidden');
    expect(getComputedStyle(header).position).toBe('sticky');
    expect(getComputedStyle(header).top).toBe('0px');
    expect(header.classList.contains('mndw-table-controls')).toBe(true);
  });

  it('makes the table header sticky via the built-in attribute', async () => {
    mountWidget();
    await flush();

    expect(tableEl()?.hasAttribute('sticky-header')).toBe(true);
  });
});

describe('locale reactivity', () => {
  it('updates the host tile title and offline label without remounting', async () => {
    const i18n = createTestI18n({
      'title': 'Clients EN',
      'show-offline': 'Offline EN',
    });

    mountWidget(i18n);

    expect(setTileTitle).toHaveBeenLastCalledWith('Clients EN');
    expect(host.querySelector('.clients-widget__header > span')).toBeNull();
    i18n.setLocale('ru', {
      'title': 'Клиенты RU',
      'show-offline': 'Не в сети RU',
    });
    await nextTick();

    expect(setTileTitle).toHaveBeenLastCalledWith('Клиенты RU');
    expect(text()).toContain('Не в сети RU');
  });
});

describe('successful load', () => {
  it('renders active clients only, keeping inactive ones cached', async () => {
    mountWidget();
    await flush();

    expect(rowNames()).toEqual(['Client A']);
    expect(text()).toContain('Client A');
  });

  it('excludes mesh infrastructure', async () => {
    mountWidget();
    await flush();

    setOffline(true);
    await flush();

    expect(rowNames()).not.toContain('Mesh Extender A');
    expect(rowNames()).not.toContain('Backhaul Link');
  });

  it('renders the activity indicator before each client name', async () => {
    mountWidget();
    await flush();

    expect(headers()[0]).toBe('Name');
    expect(headers()).not.toContain('Online');

    const nameCell = host.querySelector('.client-name-cell');

    expect(nameCell?.firstElementChild?.classList.contains('clients-table__status-indicator')).toBe(true);
    expect(nameCell?.querySelector('.client-name')?.textContent).toBe('Client A');
  });
});

describe('show offline', () => {
  it('reveals cached inactive clients without another RCI call', async () => {
    mountWidget();
    await flush();
    expect(queue).toHaveBeenCalledTimes(1);

    setOffline(true);
    await flush();

    expect(rowNames()).toEqual(['Client A', 'Former Client A', 'Former Mesh Extender B']);
    expect(host.querySelector('.clients-widget__header > span')).toBeNull();
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('persists the choice', async () => {
    mountWidget();
    await flush();

    setOffline(true);
    await flush();

    expect(storageSet).toHaveBeenCalledWith('show-offline', 'true');
  });
});

describe('polling', () => {
  it('polls on the default 3s cadence and stops on unmount', async () => {
    mountWidget();
    await flush();
    expect(queue).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);
    await flush();
    expect(queue).toHaveBeenCalledTimes(2);

    app?.unmount();
    app = null;
    unmountPluginContextFixtures();
    vi.advanceTimersByTime(30_000);
    await flush();
    expect(queue).toHaveBeenCalledTimes(2);
  });
});

describe('errors', () => {
  it('shows the table error when the first fetch fails', async () => {
    queue = vi.fn(() => throwError(() => new Error('offline')));
    mountWidget();
    await flush();

    expect(text()).toContain('Failed to show device list');
    expect(text()).not.toMatch(/Clients \(/);
    expect(host.querySelector('.clients-widget__stale--sr-only')).not.toBeNull();
    expect(host.querySelector('.clients-widget__stale')?.textContent).not.toContain('Data may be out of date');
    expect(host.querySelector('.clients-widget__stale mndw-button')).toBeNull();
  });

  it('retains stale rows and shows a stale indicator with the last success time', async () => {
    vi.setSystemTime(new Date(2026, 0, 2, 10, 20, 30));
    mountWidget();
    await flush();

    const liveRegion = host.querySelector<HTMLElement>('.clients-widget__stale [role="status"]');

    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.textContent?.trim()).toBe('');
    expect(rowNames()).toEqual(['Client A']);

    queue.mockImplementation(() => throwError(() => new Error('flaky')));
    vi.advanceTimersByTime(3000);
    await flush();

    expect(rowNames()).toEqual(['Client A']);
    expect(text()).toContain('Client A');
    expect(text()).not.toContain('Failed to show device list');

    const indicator = host.querySelector<HTMLElement>('.clients-widget__stale');
    const status = indicator?.querySelector<HTMLElement>('[role="status"]');
    const retryButton = indicator?.querySelector<HTMLElement>('mndw-button');

    expect(status).toBe(liveRegion);
    expect(indicator?.classList.contains('clients-widget__stale--sr-only')).toBe(false);
    expect(indicator?.classList.contains('mndw-alert--warning')).toBe(true);
    expect(status?.textContent).toContain('Data may be out of date — last updated at 10:20:30.');
    expect(retryButton?.textContent?.trim()).toBe('Retry');
    expect(status?.contains(retryButton ?? null)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('refetches immediately on Retry and clears the indicator on the next success', async () => {
    mountWidget();
    await flush();
    expect(queue).toHaveBeenCalledTimes(1);

    const liveRegion = host.querySelector<HTMLElement>('.clients-widget__stale [role="status"]');

    queue.mockImplementation(() => throwError(() => new Error('flaky')));
    vi.advanceTimersByTime(3000);
    await flush();
    expect(queue).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.clients-widget__stale--sr-only')).toBeNull();

    queue.mockImplementation(() => of(fixture));
    host.querySelector<HTMLElement>('.clients-widget__stale mndw-button')?.click();

    expect(queue).toHaveBeenCalledTimes(3);
    await flush();

    expect(host.querySelector('.clients-widget__stale--sr-only')).not.toBeNull();
    expect(text()).not.toContain('Data may be out of date');
    expect(rowNames()).toEqual(['Client A']);
    expect(host.querySelector('.clients-widget__stale [role="status"]')).toBe(liveRegion);
    expect(liveRegion?.textContent?.trim()).toBe('');

    vi.advanceTimersByTime(3000);
    await flush();
    expect(queue).toHaveBeenCalledTimes(4);
  });

  it('recovers on a later success after an initial failure', async () => {
    queue = vi.fn(() => throwError(() => new Error('offline')));
    mountWidget();
    await flush();
    expect(text()).toContain('Failed to show device list');

    queue.mockImplementation(() => of(fixture));
    vi.advanceTimersByTime(3000);
    await flush();

    expect(text()).not.toContain('Failed to show device list');
    expect(rowNames()).toEqual(['Client A']);
  });
});

describe('empty states', () => {
  it('distinguishes active-only from show-offline', async () => {
    queue = vi.fn(() => of({host: []}));
    mountWidget();
    await flush();

    expect(text()).toContain('No clients connected');

    setOffline(true);
    await flush();

    expect(text()).toContain('No clients found');
  });
});

describe('cell formatting', () => {
  it('renders uptime as a duration and last-seen as elapsed time', async () => {
    store.set('column-visibility', JSON.stringify({lastSeen: true}));
    mountWidget();
    await flush();

    expect(text()).toContain('24m 43s');
    expect(text()).toContain('12s ago');
  });

  it('renders a dash for null values', async () => {
    queue = vi.fn(() => of({host: [{mac: '02:00:00:00:00:01', name: 'Bare', active: true}]}));
    mountWidget();
    await flush();

    const shadowText = tableShadow().textContent ?? '';
    const rendered = text();

    expect(`${shadowText} ${rendered}`).toContain('—');
  });

  it('renders speed and port in one Connection cell', async () => {
    mountWidget();
    await flush();

    expect(text()).toContain('1000 Mbps');
    expect(text().replace(/\s+/g, ' ')).toContain('1000 Mbps Port 2');
  });
});

describe('storage', () => {
  it('hides Last seen by default, with offline off and 3s refresh', async () => {
    mountWidget();
    await flush();

    expect(headers()).toEqual(['Name', 'IP address', 'Connection', 'Uptime']);
    expect(offlineToggle().checked).toBe(false);
  });

  it('restores the stored column, offline, and interval keys', async () => {
    store.set(
      'column-visibility',
      JSON.stringify({ip: false, connection: true, uptime: true, lastSeen: true}),
    );
    store.set('show-offline', 'true');
    store.set('refresh-interval', '5');

    mountWidget();
    await flush();

    expect(headers()).not.toContain('IP address');
    expect(headers()).toContain('Last seen');
    expect(offlineToggle().checked).toBe(true);

    const afterInitial = queue.mock.calls.length;

    vi.advanceTimersByTime(3000);
    await flush();
    expect(queue).toHaveBeenCalledTimes(afterInitial);

    vi.advanceTimersByTime(2000);
    await flush();
    expect(queue).toHaveBeenCalledTimes(afterInitial + 1);
  });

  it('does not clobber a user action that landed before the read resolved', async () => {
    let releaseOffline: (value: string | null) => void = () => {};

    storageGet = vi.fn((key: string) => {
      if (key === 'show-offline') {
        return new Promise<string | null>((resolve) => {
          releaseOffline = resolve;
        });
      }

      return Promise.resolve(null);
    });

    mountWidget();
    await flush();

    setOffline(true);
    await flush();
    expect(offlineToggle().checked).toBe(true);

    releaseOffline('false');
    await flush();
    expect(offlineToggle().checked).toBe(true);
  });

  it.each([
    ['column-visibility', 'not json'],
    ['column-visibility', '"a string"'],
    ['show-offline', 'maybe'],
    ['refresh-interval', '0'],
    ['refresh-interval', '11'],
    ['refresh-interval', 'fast'],
  ])('falls back to the default for a malformed %s and warns', async (key, value) => {
    store.set(key, value);
    mountWidget();
    await flush();

    expect(warn).toHaveBeenCalled();
    expect(headers()).toContain('IP address');
    expect(offlineToggle().checked).toBe(false);
  });

  it('restores the stored RSSI thresholds', async () => {
    store.set('rssi-thresholds', JSON.stringify({good: -60, fair: -70}));

    mountWidget();
    await flush();

    host.querySelector<HTMLElement>('header mndw-button')?.click();
    await flush();

    expect(vi.mocked(openSettingsDialog).mock.calls[0][1].rssiThresholds).toEqual({good: -60, fair: -70});
  });

  it.each([
    ['malformed json', 'not json'],
    ['an out-of-range value', JSON.stringify({good: -10, fair: -75})],
    ['a good threshold below the fair one', JSON.stringify({good: -80, fair: -70})],
    ['a non-integer', JSON.stringify({good: -65.5, fair: -75})],
  ])('falls back to the default RSSI thresholds for %s and warns', async (_label, value) => {
    store.set('rssi-thresholds', value);

    mountWidget();
    await flush();

    host.querySelector<HTMLElement>('header mndw-button')?.click();
    await flush();

    expect(vi.mocked(openSettingsDialog).mock.calls[0][1].rssiThresholds).toEqual({good: -65, fair: -75});
    expect(warn).toHaveBeenCalled();
  });

  it('merges a partial column config onto defaults with Last seen hidden', async () => {
    store.set('column-visibility', JSON.stringify({connection: false, unknownColumn: true}));
    mountWidget();
    await flush();

    expect(headers()).not.toContain('Connection');
    expect(headers()).toContain('IP address');
    expect(headers()).not.toContain('Last seen');
  });

  it('stays usable when a write rejects, without showing a table error', async () => {
    storageSet = vi.fn().mockRejectedValue(new Error('quota'));
    mountWidget();
    await flush();

    setOffline(true);
    await flush();

    expect(offlineToggle().checked).toBe(true);
    expect(text()).not.toContain('Failed to show device list');
  });
});

describe('settings', () => {
  it('opens the dialog with current state and wires the callbacks', async () => {
    mountWidget();
    await flush();

    host.querySelector<HTMLElement>('header mndw-button')?.click();
    await flush();

    expect(openSettingsDialog).toHaveBeenCalledTimes(1);

    const options = vi.mocked(openSettingsDialog).mock.calls[0][1];

    expect(options.visibility).toMatchObject({ip: true, connection: true});
    expect(options.visibility.lastSeen).toBe(false);
    expect(options.refreshIntervalSeconds).toBe(3);
    expect(options.rssiThresholds).toEqual({good: -65, fair: -75});

    options.onColumnChange('connection', false);
    await flush();
    expect(headers()).not.toContain('Connection');
    expect(storageSet).toHaveBeenCalledWith('column-visibility', expect.stringContaining('"connection":false'));
  });

  it('shows Last seen and persists it when enabled in settings', async () => {
    mountWidget();
    await flush();

    host.querySelector<HTMLElement>('header mndw-button')?.click();
    await flush();

    const options = vi.mocked(openSettingsDialog).mock.calls[0][1];

    options.onColumnChange('lastSeen', true);
    await flush();

    expect(headers()).toContain('Last seen');
    expect(storageSet).toHaveBeenCalledWith('column-visibility', expect.stringContaining('"lastSeen":true'));
  });

  it('applies an interval change without an extra RCI call', async () => {
    mountWidget();
    await flush();

    const initialCalls = queue.mock.calls.length;

    host.querySelector<HTMLElement>('header mndw-button')?.click();
    await flush();

    const options = vi.mocked(openSettingsDialog).mock.calls[0][1];

    options.onRefreshIntervalChange(1);
    await flush();

    expect(queue).toHaveBeenCalledTimes(initialCalls);
    expect(storageSet).toHaveBeenCalledWith('refresh-interval', '1');

    vi.advanceTimersByTime(1000);
    await flush();
    expect(queue).toHaveBeenCalledTimes(initialCalls + 1);
  });

  it('applies a threshold change to wireless cells at once and persists it', async () => {
    queue = vi.fn(() =>
      of({host: [{mac: '02:00:00:00:00:01', name: 'Wi-Fi', active: true, mws: {ap: 'ap-1', rssi: -50, txrate: 300}}]})
    );
    mountWidget();
    await flush();

    const initialCalls = queue.mock.calls.length;

    expect(host.querySelector('.connection-cell__rssi--good')).not.toBeNull();

    host.querySelector<HTMLElement>('header mndw-button')?.click();
    await flush();

    vi.mocked(openSettingsDialog).mock.calls[0][1].onRssiThresholdsChange({good: -40, fair: -45});
    await flush();

    expect(host.querySelector('.connection-cell__rssi--weak')).not.toBeNull();
    expect(host.querySelector('.connection-cell__rssi--good')).toBeNull();
    expect(queue).toHaveBeenCalledTimes(initialCalls);
    expect(storageSet).toHaveBeenCalledWith('rssi-thresholds', '{"good":-40,"fair":-45}');
  });
});
