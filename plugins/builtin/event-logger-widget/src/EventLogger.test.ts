import {flushSync, mount, settled, unmount} from 'svelte';
import {expect, it, vi} from 'vitest';
import type {MndwEvent, PluginContext, PluginStorage} from '@mndw/sdk';
import {type TestI18n, createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import {createInstance} from './index.js';
import EventLogger from './EventLogger.svelte';
import messages from '../i18n/en.json';
import ruMessages from '../i18n/ru.json';

interface LoggerHarness {
  app: ReturnType<typeof mount>;
  close(): Promise<void>;
  emit(event: MndwEvent): void;
  i18n: TestI18n;
  resync(): void;
  target: HTMLElement;
}

function mountLogger(storage?: PluginStorage): LoggerHarness {
  const i18n = createTestI18n(messages);
  const fixture = createTestPluginContext({events: true, i18n});
  const target = document.createElement('div');

  document.body.append(target);

  const app = mount(EventLogger, {
    target,
    props: {events: fixture.context.events, i18n, storage: storage ?? fixture.context.storage.instance},
  });

  return {
    app,
    i18n,
    target,
    emit: (event) => {
      fixture.emitEvent(event);
      flushSync();
    },
    resync: () => {
      fixture.resync();
      flushSync();
    },
    async close() {
      await unmount(app);
      fixture.unmount();
      target.remove();
    },
  };
}

async function settle(): Promise<void> {
  await settled();
  flushSync();
  await Promise.resolve();
  await settled();
  flushSync();
}

function wanEvent(id: string, ts = 1): MndwEvent {
  return {id, ts, topic: 'wan.disconnected', source: 'hook', payload: {interface: id}};
}

function repeatedWanEvent(id: string, ts: number): MndwEvent {
  return {id, ts, topic: 'wan.disconnected', source: 'hook', payload: {interface: 'ppp0'}};
}

function wifiJoinEvent(id: string, ts = 2, ssid = 'HomeNet'): MndwEvent {
  return {
    id,
    ts,
    topic: 'wifi.client_join',
    source: 'log',
    payload: {mac: 'AA:BB:CC:DD:EE:FF', band: '5GHz', ssid, iface: 'wlan0'},
  };
}

function wifiLeaveEvent(id: string, ts = 3, ssid = 'HomeNet'): MndwEvent {
  return {
    id,
    ts,
    topic: 'wifi.client_leave',
    source: 'log',
    payload: {mac: 'AA:BB:CC:DD:EE:FF', band: '5GHz', ssid, iface: 'wlan0'},
  };
}

function chooseCategory(target: HTMLElement, value: string): void {
  const select = target.querySelector('mndw-select');

  if (select === null) {
    throw new Error('category select not rendered');
  }

  select.dispatchEvent(new CustomEvent('mndwchange', {bubbles: true, composed: true, detail: {value}}));
  flushSync();
}

function filterEvents(target: HTMLElement, value: string): void {
  target.querySelector('mndw-input')?.dispatchEvent(new CustomEvent('mndwinput', {detail: {value}}));
  flushSync();
}

function clickButton(target: HTMLElement, label: string): void {
  const button = [...target.querySelectorAll('mndw-button')].find((item) => {
    return item.textContent?.trim() === label;
  });

  if (button === undefined) {
    throw new Error(`button "${label}" not rendered`);
  }

  button.dispatchEvent(new MouseEvent('click', {bubbles: true}));
  flushSync();
}

it('translates visible accessibility labels', async () => {
  const fixture = createTestPluginContext({events: true});
  const target = document.createElement('div');
  const i18n = createTestI18n(messages);
  const app = mount(EventLogger, {
    target,
    props: {events: fixture.context.events, i18n, storage: fixture.context.storage.instance},
  });

  try {
    flushSync();
    expect(target.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Event log entries');
    expect(target.querySelector('mndw-input')?.getAttribute('aria-label')).toBe('Filter events');

    const select = target.querySelector('mndw-select') as (HTMLElement & {label: string}) | null;

    expect(select?.label).toBe('Event category');

    i18n.setLocale('ru', ruMessages);
    flushSync();

    expect(target.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Записи журнала событий');
    expect(target.querySelector('mndw-input')?.getAttribute('aria-label')).toBe('Фильтр событий');
    expect(select?.label).toBe('Категория событий');
  } finally {
    await unmount(app);
    fixture.unmount();
    target.remove();
  }
});
it('updates the host widget title when the locale changes', async () => {
  const i18n = createTestI18n(messages);
  const fixture = createTestPluginContext({events: true, i18n});
  const setTileTitle = vi.fn();
  const context = {...fixture.context, setTileTitle} as PluginContext;
  const target = document.createElement('div');
  const instance = createInstance(target, context);

  try {
    flushSync();
    expect(setTileTitle).toHaveBeenLastCalledWith(messages.title);
    expect(target.querySelector('h2')).toBeNull();
    i18n.setLocale('ru', ruMessages);
    flushSync();

    expect(setTileTitle).toHaveBeenLastCalledWith(ruMessages.title);
  } finally {
    await instance.unmount();
    fixture.unmount();
    target.remove();
  }
});

it('keeps filter separate from a wrapping toolbar actions group', async () => {
  const fixture = createTestPluginContext({events: true});
  const target = document.createElement('div');
  const app = mount(EventLogger, {
    target,
    props: {events: fixture.context.events, i18n: createTestI18n(messages), storage: fixture.context.storage.instance},
  });

  try {
    flushSync();

    const header = target.querySelector('header');
    const filter = header?.querySelector('mndw-input');
    const actions = header?.querySelector('.actions');

    expect(filter?.parentElement).toBe(header);
    expect(actions).not.toBeNull();
    expect(actions?.querySelectorAll('mndw-button')).toHaveLength(3);
    expect(actions?.contains(filter ?? null)).toBe(false);
  } finally {
    await unmount(app);
    fixture.unmount();
    target.remove();
  }
});

it('bounds capture oldest first, freezes while paused, clears locally, filters and cleans up', async () => {
  const fixture = createTestPluginContext({events: true});
  const target = document.createElement('div');

  document.body.append(target);

  const app = mount(EventLogger, {
    target,
    props: {events: fixture.context.events, i18n: createTestI18n(messages), storage: fixture.context.storage.instance},
  });
  const emitWithoutFlush = (id: string): void => {
    fixture.emitEvent({
      id,
      ts: 1725552000123,
      topic: 'wan.disconnected',
      source: 'hook',
      payload: {interface: id},
    });
  };
  const emit = (id: string): void => {
    emitWithoutFlush(id);
    flushSync();
  };
  const emitResync = (): void => {
    fixture.resync();
    flushSync();
  };
  const click = (label: string): void => {
    const button = [...target.querySelectorAll('mndw-button')].find((item) => {
      return item.textContent?.trim() === label;
    });

    expect(button).toBeDefined();
    button?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    flushSync();
  };

  try {
    flushSync();

    for (let index = 0; index < 501; index++) {
      emitWithoutFlush(`event-${index}`);
    }

    flushSync();
    expect(target.querySelectorAll('details')).toHaveLength(500);

    const summaries = [...target.querySelectorAll('summary')];

    expect(summaries).toHaveLength(500);
    expect(summaries[0]?.textContent).toContain('event-1');
    expect(summaries.at(-1)?.textContent).toContain('event-500');
    expect(target.textContent).not.toContain('event-0');
    click('Pause');
    emit('ignored');
    emitResync();
    expect(target.textContent).not.toContain('ignored');
    expect(target.querySelector('.marker')).toBeNull();
    click('Clear');
    emit('still-ignored');
    expect(target.querySelectorAll('details')).toHaveLength(0);
    click('Resume');
    expect(target.textContent).toContain('Capture resumed');
    emit('captured');
    emitResync();
    expect(target.textContent).toContain(messages.resync);
    target.querySelector('mndw-input')?.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: 'captured'}}));
    flushSync();
    expect(target.querySelectorAll('details')).toHaveLength(1);
    expect(target.querySelector('.marker')).toBeNull();
    click('Clear');
    emit('captured-again');
    expect(target.querySelectorAll('details')).toHaveLength(1);
  } finally {
    await unmount(app);
    fixture.unmount();
    target.remove();
  }
});

it('shows only the chosen category and keeps markers in every category', async () => {
  const harness = mountLogger();

  try {
    flushSync();
    harness.emit(wanEvent('wan'));
    harness.emit(wifiJoinEvent('wifi'));
    harness.resync();

    expect(harness.target.querySelectorAll('details')).toHaveLength(2);
    expect(harness.target.querySelector('.marker')).not.toBeNull();

    chooseCategory(harness.target, 'wifi');

    expect(harness.target.querySelectorAll('details')).toHaveLength(1);
    expect(harness.target.textContent).toContain('Wi-Fi client joined');
    expect(harness.target.querySelector('.marker')).not.toBeNull();

    chooseCategory(harness.target, 'mndw');

    expect(harness.target.querySelectorAll('details')).toHaveLength(0);
    expect(harness.target.querySelector('.marker')).not.toBeNull();

    chooseCategory(harness.target, 'all');

    expect(harness.target.querySelectorAll('details')).toHaveLength(2);
  } finally {
    await harness.close();
  }
});

it('restores the stored category and falls back to All for bad or failing storage', async () => {
  const storageFixture = createTestPluginContext();
  const storage = storageFixture.context.storage.instance;
  const failingStorage: PluginStorage = {
    get: () => Promise.reject(new Error('storage unavailable')),
    set: () => Promise.reject(new Error('storage unavailable')),
    delete: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
  };

  try {
    await storage.set('category', 'wifi');

    const restored = mountLogger(storage);

    try {
      await settle();
      restored.emit(wanEvent('wan'));
      restored.emit(wifiJoinEvent('wifi'));

      expect(restored.target.querySelectorAll('details')).toHaveLength(1);
      expect(restored.target.textContent).toContain('Wi-Fi client joined');
      expect((restored.target.querySelector('mndw-select') as HTMLElement & {value: string}).value).toBe('wifi');
    } finally {
      await restored.close();
    }

    await storage.set('category', 'nonsense');

    const fallback = mountLogger(storage);

    try {
      await settle();
      fallback.emit(wanEvent('wan'));
      fallback.emit(wifiJoinEvent('wifi'));

      expect(fallback.target.querySelectorAll('details')).toHaveLength(2);
    } finally {
      await fallback.close();
    }

    const failing = mountLogger(failingStorage);

    try {
      await settle();
      failing.emit(wanEvent('wan'));

      expect(failing.target.querySelectorAll('details')).toHaveLength(1);
      chooseCategory(failing.target, 'wifi');
      expect(failing.target.querySelectorAll('details')).toHaveLength(0);
    } finally {
      await failing.close();
    }
  } finally {
    storageFixture.unmount();
  }
});

it('collapses repeats in the view while Download keeps every event', async () => {
  const harness = mountLogger();
  const captured: {blob: Blob | null} = {blob: null};
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:events');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

  createObjectURL.mockImplementation((value: Blob | MediaSource) => {
    if (value instanceof Blob) {
      captured.blob = value;
    }

    return 'blob:events';
  });

  try {
    flushSync();
    harness.emit(repeatedWanEvent('repeat-0', 1000));
    harness.emit(repeatedWanEvent('repeat-1', 1001));
    harness.emit(repeatedWanEvent('repeat-2', 1002));
    harness.emit({
      id: 'other',
      ts: 2000,
      topic: 'wan.disconnected',
      source: 'hook',
      payload: {interface: 'ppp1'},
    });

    const rows = harness.target.querySelectorAll('details');

    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('summary')?.textContent).toContain('×3');
    expect(rows[0]?.querySelector('.sr-only')?.textContent).toBe('Repeated 3 times');

    const download = [...harness.target.querySelectorAll('mndw-button')].find((item) => {
      return item.textContent?.trim() === 'Download log';
    });

    download?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    flushSync();

    expect(anchorClick).toHaveBeenCalledOnce();

    const blob = captured.blob;

    expect(blob).not.toBeNull();

    const entries = blob === null ? [] : JSON.parse(await blob.text()) as Array<{id?: string}>;

    expect(entries.map((entry) => entry.id)).toEqual(['repeat-0', 'repeat-1', 'repeat-2', 'other']);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:events');

    harness.i18n.setLocale('ru', ruMessages);
    flushSync();

    const ruRepeated = harness.target.querySelectorAll('details')[0];

    expect(ruRepeated?.querySelector('.sr-only')?.textContent).toBe('Повторено 3 раза');
  } finally {
    vi.restoreAllMocks();
    await harness.close();
  }
});

it('keeps an expanded repeat group open when another identical event arrives', async () => {
  const harness = mountLogger();

  try {
    flushSync();
    harness.emit(repeatedWanEvent('repeat-0', 1000));
    harness.emit(repeatedWanEvent('repeat-1', 1001));

    const expanded = harness.target.querySelector('details');

    expect(expanded).not.toBeNull();

    if (expanded === null) {
      throw new Error('repeat group not rendered');
    }

    expanded.open = true;
    flushSync();
    harness.emit(repeatedWanEvent('repeat-2', 1002));

    const after = harness.target.querySelector('details');

    expect(after).toBe(expanded);
    expect(after?.open).toBe(true);
    expect(after?.querySelector('.count')?.textContent).toBe('×3');
  } finally {
    await harness.close();
  }
});

it('sticks to the bottom only while pinned, and jumps to the bottom on clear and filter changes', async () => {
  const harness = mountLogger();

  try {
    await settle();

    const region = harness.target.querySelector<HTMLElement>('.entries');

    expect(region).not.toBeNull();

    if (region === null) {
      throw new Error('entries region not rendered');
    }

    Object.defineProperty(region, 'scrollHeight', {configurable: true, value: 1000});
    Object.defineProperty(region, 'clientHeight', {configurable: true, value: 400});

    region.scrollTop = 200;
    harness.emit(wanEvent('scrolled-up'));
    await settle();

    expect(region.scrollTop).toBe(200);

    region.scrollTop = 600;
    harness.emit(wanEvent('pinned'));
    await settle();

    expect(region.scrollTop).toBeGreaterThanOrEqual(600);

    region.scrollTop = 0;
    clickButton(harness.target, 'Clear');
    await settle();

    expect(region.scrollTop).toBeGreaterThanOrEqual(600);

    region.scrollTop = 0;
    filterEvents(harness.target, 'nothing-matches');
    await settle();

    expect(region.scrollTop).toBeGreaterThanOrEqual(600);

    region.scrollTop = 0;
    chooseCategory(harness.target, 'wifi');
    await settle();

    expect(region.scrollTop).toBeGreaterThanOrEqual(600);
  } finally {
    await harness.close();
  }
});

it('matches the text filter against the localized summary', async () => {
  const harness = mountLogger();
  const joinedAt = 1725552000123;

  try {
    flushSync();
    harness.emit(wifiJoinEvent('join', joinedAt));
    harness.emit(wifiLeaveEvent('leave', joinedAt + 5000));

    filterEvents(harness.target, 'joined');

    const enTime = harness.i18n.formatDate(new Date(joinedAt), {timeStyle: 'medium'});

    expect(harness.target.querySelectorAll('details')).toHaveLength(1);
    expect(harness.target.textContent).toContain('Wi-Fi client joined');
    expect(harness.target.querySelector('time')?.textContent).toBe(enTime);

    harness.i18n.setLocale('ru', ruMessages);
    flushSync();
    filterEvents(harness.target, 'подключён');

    const ruTime = harness.i18n.formatDate(new Date(joinedAt), {timeStyle: 'medium'});

    expect(harness.target.querySelectorAll('details')).toHaveLength(1);
    expect(harness.target.textContent).toContain('Wi-Fi клиент подключён');
    expect(harness.target.querySelector('time')?.textContent).toBe(ruTime);
    expect(ruTime).not.toBe(enTime);
  } finally {
    await harness.close();
  }
});
