// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PluginContext} from '@mndw/sdk';
import type {RciManager, RciQuery} from '@rci-tools/core';
import {type Observable, of, throwError} from 'rxjs';
import {type App as VueApp, createApp} from 'vue';
import fixture from './fixtures/show-device-list.json' with {type: 'json'};
import {openSettingsDialog} from './services/open-settings-dialog.js';
import App from './App.vue';

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

function createContext(): PluginContext {
  return {
    rciManager: {queue} as unknown as RciManager,
    storage: {
      get: storageGet,
      set: storageSet,
      delete: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockResolvedValue([]),
    },
    overlay: {open: overlayOpen, createLayer: vi.fn(), closeAll: vi.fn()},
  } as unknown as PluginContext;
}

function mountWidget(): void {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(App, {ctx: createContext()});
  app.mount(host);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function text(): string {
  return host.textContent ?? '';
}

function rowNames(): string[] {
  return [...host.querySelectorAll('tbody tr')]
    .map((row) => row.querySelector('td')?.textContent?.trim() ?? '');
}

function headers(): string[] {
  return [...host.querySelectorAll('thead th')].map((cell) => cell.textContent?.trim() ?? '');
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
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(openSettingsDialog).mockClear();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  warn.mockRestore();
  vi.useRealTimers();
});

describe('initial render', () => {
  it('shows the loading copy and a bare header before the first response', () => {
    queue = vi.fn(() => new Observable<unknown>(() => {}));
    mountWidget();

    expect(text()).toContain('Loading clients…');
    expect(text()).toContain('Clients');
    expect(text()).not.toMatch(/Clients \(/);
  });

  it('keeps header visible while widget content scrolls', () => {
    mountWidget();

    const widget = host.querySelector<HTMLElement>('.clients-widget');
    const header = host.querySelector<HTMLElement>('.clients-widget__header');

    if (widget === null || header === null) {
      throw new Error('widget header was not rendered');
    }

    expect(getComputedStyle(widget).overflow).toBe('auto');
    expect(getComputedStyle(header).position).toBe('sticky');
    expect(getComputedStyle(header).top).toBe('0px');
  });

  it('keeps table headers sticky below the widget header', async () => {
    document.documentElement.style.setProperty('--mndw-control-h', '32px');
    mountWidget();
    await flush();

    const tableHead = host.querySelector<HTMLElement>('.clients-table thead');

    try {
      if (tableHead === null) {
        throw new Error('table header was not rendered');
      }

      expect(getComputedStyle(tableHead).position).toBe('sticky');
      expect(getComputedStyle(tableHead).top).toBe('32px');
    } finally {
      document.documentElement.style.removeProperty('--mndw-control-h');
    }
  });
});

describe('successful load', () => {
  it('renders active clients only, keeping inactive ones cached', async () => {
    mountWidget();
    await flush();

    expect(rowNames()).toEqual(['Client A']);
    expect(text()).toContain('Clients (1)');
  });

  it('excludes mesh infrastructure', async () => {
    mountWidget();
    await flush();

    setOffline(true);
    await flush();

    expect(rowNames()).not.toContain('Mesh Extender A');
    expect(rowNames()).not.toContain('Backhaul Link');
  });

  it('always renders Name and Link columns', async () => {
    mountWidget();
    await flush();

    expect(headers()[0]).toBe('Name');
    expect(headers()).toContain('Link');
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
    expect(text()).toContain('Clients (3)');
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

    expect(text()).toContain('show device-list failed');
    expect(text()).not.toMatch(/Clients \(/);
  });

  it('retains stale rows and warns when a background refresh fails', async () => {
    mountWidget();
    await flush();
    expect(rowNames()).toEqual(['Client A']);

    queue.mockImplementation(() => throwError(() => new Error('flaky')));
    vi.advanceTimersByTime(3000);
    await flush();

    expect(rowNames()).toEqual(['Client A']);
    expect(text()).toContain('Clients (1)');
    expect(text()).not.toContain('show device-list failed');
    expect(warn).toHaveBeenCalled();
  });

  it('recovers on a later success after an initial failure', async () => {
    queue = vi.fn(() => throwError(() => new Error('offline')));
    mountWidget();
    await flush();
    expect(text()).toContain('show device-list failed');

    queue.mockImplementation(() => of(fixture));
    vi.advanceTimersByTime(3000);
    await flush();

    expect(text()).not.toContain('show device-list failed');
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
    mountWidget();
    await flush();

    expect(text()).toContain('24m 43s');
    expect(text()).toContain('12s ago');
  });

  it('renders a dash for null values', async () => {
    queue = vi.fn(() => of({host: [{mac: '02:00:00:00:00:01', name: 'Bare', active: true}]}));
    mountWidget();
    await flush();

    const cells = [...host.querySelectorAll('tbody td')].map((cell) => cell.textContent?.trim());

    expect(cells.filter((cell) => cell === '—').length).toBeGreaterThan(0);
  });

  it('renders speed and port in one Connection cell', async () => {
    mountWidget();
    await flush();

    expect(text()).toContain('1000 Mbps');

    const connectionIndex = headers().indexOf('Connection');
    const cell = host.querySelectorAll('tbody tr')[0]?.querySelectorAll('td')[connectionIndex];

    expect(cell?.textContent?.replace(/\s+/g, ' ').trim()).toBe('1000 Mbps Port 2');
  });
});

describe('storage', () => {
  it('defaults to all columns visible, offline off, 3s', async () => {
    mountWidget();
    await flush();

    expect(headers()).toEqual(['Name', 'Link', 'IP Address', 'Connection', 'Uptime', 'Last Seen']);
    expect(offlineToggle().checked).toBe(false);
  });

  it('restores all three keys', async () => {
    store.set(
      'column-visibility',
      JSON.stringify({ip: false, connection: true, uptime: true, lastSeen: true}),
    );
    store.set('show-offline', 'true');
    store.set('refresh-interval', '5');

    mountWidget();
    await flush();

    expect(headers()).not.toContain('IP Address');
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
    expect(headers()).toContain('IP Address');
    expect(offlineToggle().checked).toBe(false);
  });

  it('merges a partial column config onto all-visible', async () => {
    store.set('column-visibility', JSON.stringify({connection: false, unknownColumn: true}));
    mountWidget();
    await flush();

    expect(headers()).not.toContain('Connection');
    expect(headers()).toContain('IP Address');
  });

  it('stays usable when a write rejects, without showing a table error', async () => {
    storageSet = vi.fn().mockRejectedValue(new Error('quota'));
    mountWidget();
    await flush();

    setOffline(true);
    await flush();

    expect(offlineToggle().checked).toBe(true);
    expect(text()).not.toContain('show device-list failed');
  });
});

describe('settings', () => {
  it('opens the dialog with current state and wires the callbacks', async () => {
    mountWidget();
    await flush();

    host.querySelector<HTMLElement>('header mndw-button')?.click();
    await flush();

    expect(openSettingsDialog).toHaveBeenCalledTimes(1);

    const [, visibility, intervalSeconds, onChange, _onRefreshIntervalChange] =
      vi.mocked(openSettingsDialog).mock.calls[0];

    expect(visibility).toMatchObject({ip: true, connection: true});
    expect(intervalSeconds).toBe(3);

    onChange('connection', false);
    await flush();
    expect(headers()).not.toContain('Connection');
    expect(storageSet).toHaveBeenCalledWith('column-visibility', expect.stringContaining('"connection":false'));
  });

  it('applies an interval change without an extra RCI call', async () => {
    mountWidget();
    await flush();

    const initialCalls = queue.mock.calls.length;

    host.querySelector<HTMLElement>('header mndw-button')?.click();
    await flush();

    const [, , , , onRefreshIntervalChange] = vi.mocked(openSettingsDialog).mock.calls[0];

    onRefreshIntervalChange(1);
    await flush();

    expect(queue).toHaveBeenCalledTimes(initialCalls);
    expect(storageSet).toHaveBeenCalledWith('refresh-interval', '1');

    vi.advanceTimersByTime(1000);
    await flush();
    expect(queue).toHaveBeenCalledTimes(initialCalls + 1);
  });
});
