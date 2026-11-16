// @vitest-environment happy-dom
import {NEVER, Observable, Subject, of, throwError} from 'rxjs';
import {flushSync, mount, settled, unmount} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {OverlayLayer, OverlayOpenOptions, OverlayService, PluginI18n} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import enCatalog from '../i18n/en.json';
import type {RciBackgroundProcess} from '@rci-tools/core';
import type {SystemLogApi, SystemLogStream} from './system-log-api';
import type {NormalizedLogRecord} from './log-types';
import type {ClearResult} from './clear-log-confirmation';
import SystemLogPage from './SystemLogPage.svelte';
import systemLogPageSource from './SystemLogPage.svelte?raw';

function record(id: number, text = `record ${id}`): NormalizedLogRecord {
  return {id, timestamp: 'Aug  1 12:00:00', ident: 'system', level: 'Info', label: 'Info', text};
}

function process(): {value: RciBackgroundProcess; abort: ReturnType<typeof vi.fn>} {
  const abort = vi.fn(() => true);

  return {
    value: {
      data$: NEVER,
      done$: new Subject(),
      state$: new Subject(),
      abort,
    } as unknown as RciBackgroundProcess,
    abort,
  };
}

interface StreamSession {
  stream: SystemLogStream;
  data: Subject<NormalizedLogRecord[]>;
  done: Subject<void>;
  abort: ReturnType<typeof vi.fn>;
}

function streamSession(): StreamSession {
  const data = new Subject<NormalizedLogRecord[]>();
  const done = new Subject<void>();
  const abort = vi.fn(() => true);
  const backgroundProcess = {
    data$: data.asObservable(),
    done$: done.asObservable(),
    state$: NEVER,
    abort,
  } as unknown as RciBackgroundProcess;

  return {
    stream: {process: backgroundProcess, data$: data.asObservable()},
    data,
    done,
    abort,
  };
}

function reconnectingApi(snapshot: () => Observable<NormalizedLogRecord[]> = () => NEVER): {
  api: SystemLogApi;
  sessions: StreamSession[];
  showLogOnce: ReturnType<typeof vi.fn>;
  startLogStream: ReturnType<typeof vi.fn>;
} {
  const sessions: StreamSession[] = [];
  const showLogOnce = vi.fn(snapshot);
  const startLogStream = vi.fn(() => {
    const nextSession = streamSession();

    sessions.push(nextSession);

    return nextSession.stream;
  });

  return {
    api: {showLogOnce, startLogStream, clearLog: () => of({})},
    sessions,
    showLogOnce,
    startLogStream,
  };
}

function mountLogPage(target: HTMLElement, api: SystemLogApi): ReturnType<typeof mount> {
  document.body.appendChild(target);

  return mount(SystemLogPage, {
    target,
    props: {api, overlay: {} as OverlayService, i18n: createTestI18n(enCatalog)},
  });
}

function changingI18n(): {i18n: PluginI18n; setLocale(locale: 'en' | 'ru'): void} {
  const messages = {
    en: {
      'action.download': 'Download log',
      'filter.label': 'Filters',
      'status': {connection: {connected: 'Connected'}},
    },
    ru: {
      'action.download': 'Скачать журнал',
      'filter.label': 'Фильтры',
      'status': {connection: {connected: 'Подключено'}},
    },
  };
  const i18n = createTestI18n(messages.en);

  return {
    i18n,
    setLocale: (nextLocale) => {
      i18n.setLocale(nextLocale, messages[nextLocale]);
    },
  };
}

function trackedObservable<T>(value: T, counters: {subscriptions: number; unsubscriptions: number}): Observable<T> {
  return new Observable<T>((subscriber) => {
    counters.subscriptions += 1;
    subscriber.next(value);

    return () => {
      counters.unsubscriptions += 1;
    };
  });
}

function immediateConfirmationOverlay(confirmed: boolean): OverlayService {
  return {
    open: (options: OverlayOpenOptions<ClearResult>) => {
      const target = document.createElement('div');
      let cleanup: (() => void | Promise<void>) | undefined;
      const session = {
        signal: new AbortController().signal,
        contentElement: target,
        hostElement: target,
        isOpen: true,
        state: 'open',
        closed: Promise.resolve({reason: 'action', result: {confirmed}}),
        close: vi.fn(),
        setCleanup: (next: () => void | Promise<void>) => {
          cleanup = next;
        },
      };

      void options.mount(target, session as unknown as OverlayLayer<ClearResult>, session.signal);
      void cleanup;

      return session;
    },
  } as unknown as OverlayService;
}

describe('SystemLogPage lifecycle', () => {
  let host: HTMLElement;

  afterEach(() => {
    host?.remove();
  });

  it('updates mounted translated controls when locale changes', () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    const streamProcess = process().value;
    const api: SystemLogApi = {
      showLogOnce: () => NEVER,
      startLogStream: () => ({process: streamProcess, data$: NEVER}),
      clearLog: () => of({}),
    };
    const changing = changingI18n();
    const app = mount(SystemLogPage, {
      target: host,
      props: {api, overlay: {} as OverlayService, i18n: changing.i18n},
    });

    flushSync();
    expect(host.querySelector('[data-download-log]')?.textContent).toContain('Download');
    expect(host.querySelector('[data-connection-status]')?.textContent).toContain('Connected');

    changing.setLocale('ru');
    flushSync();

    expect(host.querySelector('[data-download-log]')?.textContent).toContain('Скачать журнал');
    expect(host.querySelector('[data-connection-status]')?.textContent).toContain('Подключено');
    expect(host.querySelector('[data-filter-panel]')?.textContent).toContain('Фильтры');
    void unmount(app);
  });

  it('subscribes to snapshot and stream and tears both down with process abort', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    const snapshotCounters = {subscriptions: 0, unsubscriptions: 0};
    const streamCounters = {subscriptions: 0, unsubscriptions: 0};
    const streamSetup = process();
    const streamProcess = streamSetup.value;
    const api: SystemLogApi = {
      showLogOnce: () => trackedObservable([record(1)], snapshotCounters),
      startLogStream: () => ({process: streamProcess, data$: trackedObservable([record(2)], streamCounters)}),
      clearLog: () => of({}),
    };

    const app = mount(SystemLogPage, {target: host,
      props: {api, overlay: {} as OverlayService, i18n: createTestI18n(enCatalog)}});

    flushSync();
    expect(snapshotCounters.subscriptions).toBe(1);
    expect(streamCounters.subscriptions).toBe(1);
    expect(host.querySelector('[data-system-log-page]')).not.toBeNull();

    const header = host.querySelector('.system-log-page__header');

    expect(header?.querySelector('[data-filter-panel]')).not.toBeNull();
    expect(header?.querySelector('[data-download-log]')).not.toBeNull();
    expect(header?.querySelector('[data-clear-log]')).not.toBeNull();
    expect(host.querySelector('.system-log-page > [data-filter-panel]')).toBeNull();
    expect(host.querySelector('[data-download-log]')?.textContent).toContain('Download');
    expect(host.textContent).not.toMatch(/refresh/i);

    await unmount(app);

    expect(snapshotCounters.unsubscriptions).toBe(1);
    expect(streamCounters.unsubscriptions).toBe(1);
    expect(streamSetup.abort).toHaveBeenCalledTimes(1);
  });

  it('renders loaded and filtered counts and only autoscrolls when near bottom', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    const snapshot$ = new Subject<NormalizedLogRecord[]>();
    const stream$ = new Subject<NormalizedLogRecord[]>();
    const streamProcess = process().value;
    const api: SystemLogApi = {
      showLogOnce: () => snapshot$.asObservable(),
      startLogStream: () => ({process: streamProcess, data$: stream$.asObservable()}),
      clearLog: () => of({}),
    };
    const app = mount(SystemLogPage, {target: host,
      props: {api, overlay: {} as OverlayService, i18n: createTestI18n(enCatalog)}});

    flushSync();

    const viewport = host.querySelector<HTMLElement>('[data-log-viewport]');

    expect(viewport).not.toBeNull();

    const scrollTo = vi.fn();
    let scrollTop = 32;
    let clientHeight = 68;
    let scrollHeight = 100;

    Object.defineProperties(viewport, {
      scrollTop: {configurable: true, get: () => scrollTop},
      clientHeight: {configurable: true, get: () => clientHeight},
      scrollHeight: {configurable: true, get: () => scrollHeight},
      scrollTo: {configurable: true, value: scrollTo},
    });

    stream$.next([record(1)]);
    await settled();
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({top: 100}));
    expect(host.querySelector('[data-loaded-count]')?.textContent).toContain('1');
    expect(host.querySelector('[data-filtered-count]')?.textContent).toContain('1');
    expect(host.querySelector('[data-filter-panel]')?.textContent).toContain('Showing 1 of 1 items');

    scrollTop = 0;
    scrollHeight = 200;
    stream$.next([record(2)]);
    await settled();
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
    expect(scrollTo).toHaveBeenCalledTimes(1);

    scrollTop = 100;
    clientHeight = 68;
    stream$.next([record(3)]);
    await settled();
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(2));
    expect(scrollTo).toHaveBeenCalledTimes(2);

    expect(host.querySelector('[data-download-log]')).not.toBeNull();
    expect(host.querySelector('[data-clear-log]')).not.toBeNull();
    expect(host.textContent).not.toMatch(/refresh/i);

    await unmount(app);
  });

  it('clears local state only after confirmation and successful RCI response', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    const clear$ = new Subject<unknown>();
    const stream$ = new Subject<NormalizedLogRecord[]>();
    const clearLog = vi.fn(() => clear$.asObservable());
    const streamProcess = process().value;
    const api: SystemLogApi = {
      showLogOnce: () => of([record(1, 'old')]),
      startLogStream: () => ({process: streamProcess, data$: stream$.asObservable()}),
      clearLog,
    };
    const app = mount(SystemLogPage, {
      target: host,
      props: {api, overlay: immediateConfirmationOverlay(true), i18n: createTestI18n(enCatalog)},
    });

    await settled();
    host.querySelector<HTMLElement>('[data-clear-log]')?.click();
    await vi.waitFor(() => expect(clearLog).toHaveBeenCalledTimes(1));
    clear$.next({success: true});
    await vi.waitFor(() => expect(host.querySelector('[data-loaded-count]')?.textContent).toContain('0'));
    expect(host.querySelector('[data-loaded-count]')?.textContent).toContain('0');

    stream$.next([record(1, 'fresh after clear')]);
    await settled();
    expect(host.textContent).toContain('fresh after clear');

    await unmount(app);
  });

  it('does not call clear for cancellation and preserves records on failure', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    const clearLog = vi.fn(() => throwError(() => new Error('clear failed')));
    const streamProcess = process().value;
    const api: SystemLogApi = {
      showLogOnce: () => of([record(1, 'preserve me')]),
      startLogStream: () => ({process: streamProcess, data$: NEVER}),
      clearLog,
    };
    const app = mount(SystemLogPage, {
      target: host,
      props: {api, overlay: immediateConfirmationOverlay(false), i18n: createTestI18n(enCatalog)},
    });

    await settled();
    host.querySelector<HTMLElement>('[data-clear-log]')?.click();
    await settled();
    expect(clearLog).not.toHaveBeenCalled();
    expect(host.textContent).toContain('preserve me');
    await unmount(app);

    host = document.createElement('div');
    document.body.appendChild(host);

    const failedApp = mount(SystemLogPage, {
      target: host,
      props: {api, overlay: immediateConfirmationOverlay(true), i18n: createTestI18n(enCatalog)},
    });

    await settled();
    host.querySelector<HTMLElement>('[data-clear-log]')?.click();
    await vi.waitFor(() => expect(host.textContent).toMatch(/clear failed/i));
    expect(host.textContent).toContain('preserve me');
    expect(host.querySelector('[data-clear-error]')?.textContent).toMatch(/clear failed/i);
    expect(host.querySelector('[data-connection-status]')?.textContent).toContain('Connected');
    await unmount(failedApp);
  });

  it('clears a prior clear failure after a later clear succeeds', async () => {
    host = document.createElement('div');

    const clearLog = vi.fn()
      .mockImplementationOnce(() => throwError(() => new Error('clear failed')))
      .mockImplementationOnce(() => of({success: true}));
    const api: SystemLogApi = {
      showLogOnce: () => NEVER,
      startLogStream: () => ({process: process().value, data$: NEVER}),
      clearLog,
    };
    const app = mount(SystemLogPage, {
      target: host,
      props: {api, overlay: immediateConfirmationOverlay(true), i18n: createTestI18n(enCatalog)},
    });

    await settled();
    host.querySelector<HTMLElement>('[data-clear-log]')?.click();
    await vi.waitFor(() => expect(host.querySelector('[data-clear-error]')).not.toBeNull());
    host.querySelector<HTMLElement>('[data-clear-log]')?.click();
    await vi.waitFor(() => expect(clearLog).toHaveBeenCalledTimes(2));

    expect(host.querySelector('[data-clear-error]')).toBeNull();
    await unmount(app);
  });
});

describe('SystemLogPage stream reconnection', () => {
  let host: HTMLElement;

  afterEach(() => {
    vi.useRealTimers();
    host?.remove();
  });

  it('restarts the stream and snapshot after a stream error and reconciles duplicate rows', async () => {
    vi.useFakeTimers();

    const snapshots = [
      of([record(1), record(2)]),
      of([record(1), record(2), record(3)]),
    ];
    const setup = reconnectingApi(() => snapshots.shift() ?? NEVER);

    host = document.createElement('div');

    const app = mountLogPage(host, setup.api);

    flushSync();
    setup.sessions[0]?.data.next([record(1), record(2)]);
    setup.sessions[0]?.data.error(new Error('stream closed'));
    flushSync();

    expect(host.querySelector('[data-reconnect-countdown]')?.textContent).toContain('1 s');

    await vi.advanceTimersByTimeAsync(1000);
    flushSync();
    setup.sessions[1]?.data.next([record(2), record(3), record(4)]);
    flushSync();

    expect(setup.startLogStream).toHaveBeenCalledTimes(2);
    expect(setup.showLogOnce).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-loaded-count]')?.textContent).toContain('4');
    expect(host.querySelectorAll('[data-log-id]')).toHaveLength(4);

    await unmount(app);
  });

  it('does not put the countdown or Reconnect action inside the live region', async () => {
    vi.useFakeTimers();

    const setup = reconnectingApi();

    host = document.createElement('div');

    const app = mountLogPage(host, setup.api);

    flushSync();
    setup.sessions[0]?.data.error(new Error('stream closed'));
    flushSync();
    vi.advanceTimersByTime(1000);
    flushSync();
    setup.sessions[1]?.data.error(new Error('stream closed again'));
    flushSync();

    const status = host.querySelector('[role="status"]');
    const countdown = host.querySelector('[data-reconnect-countdown]');

    expect(status?.querySelector('[data-reconnect]')).toBeNull();
    expect(status?.textContent?.trim()).toBe('Reconnecting');
    expect(status?.textContent).not.toContain('2 s');
    expect(countdown?.closest('[role="status"]')).toBeNull();
    expect(countdown?.textContent).toContain('2 s');

    vi.advanceTimersByTime(1000);
    flushSync();

    expect(host.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent?.trim()).toBe('Reconnecting');
    expect(host.querySelector('[data-reconnect-countdown]')?.textContent).toContain('1 s');
    expect(host.querySelector('[data-reconnect]')?.closest('[role="status"]')).toBeNull();
    await unmount(app);
  });
});

describe('SystemLogPage scrollbar contract', () => {
  it('keeps native log scrolling visibly tokenized in dark theme', () => {
    expect(systemLogPageSource).toMatch(
      /scrollbar-color:\s*var\(--mndw-scrollbar-thumb\)\s+var\(--mndw-scrollbar-track\)/u,
    );
    expect(systemLogPageSource).toMatch(/system-log-page__viewport::-webkit-scrollbar-thumb/u);
  });

  it('wraps connection content and long errors on narrow layouts', () => {
    expect(systemLogPageSource).toMatch(/\.system-log-page__connection\s*\{[^}]*flex-wrap:\s*wrap/su);
    expect(systemLogPageSource).toMatch(/\.system-log-page__connection-error\s*\{[^}]*overflow-wrap:\s*anywhere/su);
  });
});
