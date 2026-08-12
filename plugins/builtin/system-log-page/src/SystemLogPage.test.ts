// @vitest-environment happy-dom
import {NEVER, Observable, Subject, of, throwError} from 'rxjs';
import {flushSync, mount, settled, unmount} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {OverlayLayer, OverlayOpenOptions, OverlayService, PluginI18n} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import enCatalog from '../i18n/en.json';
import type {RciBackgroundProcess} from '@rci-tools/core';
import type {SystemLogApi} from './system-log-api';
import type {NormalizedLogRecord} from './log-types';
import type {ClearResult} from './clear-log-confirmation';
import SystemLogPage from './SystemLogPage.svelte';

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

function changingI18n(): {i18n: PluginI18n; setLocale(locale: 'en' | 'ru'): void} {
  const messages = {
    en: {title: 'System Log', 'filter.label': 'Filters', l10n: {probe: 'System Log English'}},
    ru: {title: 'Системный журнал', 'filter.label': 'Фильтры', l10n: {probe: 'Системный журнал русский'}},
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
    expect(host.querySelector('h1')?.textContent).toBe('System Log English');
    const probe = host.querySelector<HTMLElement>('[data-testid="l10n-probe"]');
    expect(probe).not.toBeNull();
    const enValue = probe?.textContent;
    expect(enValue).toBe('System Log English');

    changing.setLocale('ru');
    flushSync();

    expect(host.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(enValue).not.toBe('Системный журнал русский');
    expect(probe?.textContent).toBe('Системный журнал русский');
    expect(host.querySelector('h1')?.textContent).toBe('Системный журнал русский');
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

    const app = mount(SystemLogPage, {target: host, props: {api, overlay: {} as OverlayService, i18n: createTestI18n(enCatalog)}});

    flushSync();
    expect(snapshotCounters.subscriptions).toBe(1);
    expect(streamCounters.subscriptions).toBe(1);
    expect(host.querySelector('[data-system-log-page]')).not.toBeNull();

    const header = host.querySelector('.system-log-page__header');

    expect(header?.querySelector('[data-filter-panel]')).not.toBeNull();
    expect(header?.querySelector('[data-download-log]')).not.toBeNull();
    expect(header?.querySelector('[data-clear-log]')).not.toBeNull();
    expect(host.querySelector('.system-log-page > [data-filter-panel]')).toBeNull();
    expect(host.querySelector('h1')?.textContent).toContain('System log English');
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
    const app = mount(SystemLogPage, {target: host, props: {api, overlay: {} as OverlayService, i18n: createTestI18n(enCatalog)}});

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
    await unmount(failedApp);
  });
});
