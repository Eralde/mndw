// @vitest-environment happy-dom
import {flushSync, mount, settled, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient, OverlayOpenOptions, PluginContext, PluginStorage} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import enCatalog from '../i18n/en.json';
import ruCatalog from '../i18n/ru.json';
import IperfWidget from './IperfWidget.svelte';

class FakeSocket {
  public readyState = 1;
  public sent: string[] = [];
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
    this.onclose?.(new Event('close') as CloseEvent);
    flushSync();
  }

  public emit(message: unknown): void {
    this.onmessage?.({data: JSON.stringify(message)} as MessageEvent);
    flushSync();
  }
}

interface MountedWidget {
  app: ReturnType<typeof mount<typeof IperfWidget>>;
  appUnmounted: boolean;
  context: PluginContext;
  readonly observer: FakeResizeObserver | null;
  socket: FakeSocket;
  storage: PluginStorage;
  overlayTargets: HTMLElement[];
  resize(height: number): void;
  target: HTMLElement;
  teardown(): void;
}

const mounted: MountedWidget[] = [];
const resizeObservers: FakeResizeObserver[] = [];

class FakeResizeObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;
  public observedTarget: Element | null = null;
  public disconnected = false;

  public constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }

  public observe(target: Element): void {
    this.observedTarget = target;
  }

  public unobserve(target: Element): void {
    if (this.observedTarget === target) {
      this.observedTarget = null;
    }
  }

  public disconnect(): void {
    this.disconnected = true;
    this.observedTarget = null;
  }

  public emit(height: number): void {
    const target = this.observedTarget;

    if (target === null) {
      return;
    }

    this.callback([{
      target,
      contentRect: {height} as DOMRectReadOnly,
    } as ResizeObserverEntry], this);
  }
}

beforeEach(() => {
  resizeObservers.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

function createWidget(locale: 'en' | 'ru' = 'en'): MountedWidget {
  const socket = new FakeSocket();
  const backend = {socket: vi.fn(() => socket as unknown as WebSocket)} as unknown as BackendClient;
  const catalog = locale === 'ru' ? ruCatalog : enCatalog;
  const fixture = createTestPluginContext({i18n: createTestI18n(catalog, locale)});
  const overlayTargets: HTMLElement[] = [];
  const overlay = {
    open: (options: OverlayOpenOptions) => {
      const target = document.createElement('div');

      document.body.append(target);
      overlayTargets.push(target);

      const layer = {
        setCleanup: (cleanup: () => void) => {
          target.dataset.cleanup = 'registered';
          target.addEventListener('remove', cleanup, {once: true});
        },
        close: () => {
          target.dispatchEvent(new Event('remove'));
          target.remove();
        },
      };

      options.mount(target, layer as never, new AbortController().signal);

      return layer as never;
    },
  };
  const context = {...fixture.context, backend, overlay} as PluginContext;
  const target = document.createElement('div');

  document.body.append(target);

  const app = mount(IperfWidget, {
    target,
    props: {context},
  });
  const entry: MountedWidget = {
    app,
    appUnmounted: false,
    context,
    get observer(): FakeResizeObserver | null {
      const widgetRoot = target.querySelector('.widget');

      return resizeObservers.find((candidate) => candidate.observedTarget === widgetRoot) ?? null;
    },
    socket,
    storage: fixture.context.storage.instance,
    overlayTargets,
    resize: (height) => {
      const widgetRoot = target.querySelector('.widget');

      resizeObservers.find((candidate) => candidate.observedTarget === widgetRoot)?.emit(height);
    },
    target,
    teardown: () => fixture.unmount(),
  };

  mounted.push(entry);

  return entry;
}

async function ready(_widget: MountedWidget): Promise<void> {
  flushSync();
  await settled();
  flushSync();
  await settled();
}

function click(target: HTMLElement, selector: string): void {
  const button = target.querySelector<HTMLElement>(selector);

  expect(button).not.toBeNull();
  button?.click();

  if (button?.localName === 'mndw-button' && (button as HTMLElement & {type?: string}).type === 'submit') {
    const form = button.closest('form');
    const event = new SubmitEvent('submit', {bubbles: true, cancelable: true});

    expect(form).not.toBeNull();
    form?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }

  flushSync();
}

function setInputValue(target: HTMLElement, name: string, value: string): void {
  const input = target.querySelector<HTMLElement & {value: string}>(`mndw-input[name="${name}"]`);

  expect(input).not.toBeNull();

  if (input) {
    input.value = value;
    input.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value}}));
    flushSync();
  }
}

afterEach(async () => {
  vi.useRealTimers();

  for (const widget of mounted.splice(0)) {
    if (!widget.appUnmounted) {
      await unmount(widget.app);
    }

    widget.teardown();
    widget.target.remove();

    for (const overlayTarget of widget.overlayTargets) {
      overlayTarget.dispatchEvent(new Event('remove'));
      overlayTarget.remove();
    }
  }

  vi.unstubAllGlobals();
});

describe('IperfWidget', () => {
  it('shows the default server and starts with its resolved target', async () => {
    const widget = createWidget();

    await ready(widget);

    const settingsButton = widget.target.querySelector('header mndw-button[data-testid="settings"]');
    const historyButton = widget.target.querySelector('header mndw-button[data-testid="history"]');
    const server = widget.target.querySelector<HTMLElement>('header .server');
    const start = widget.target.querySelector<HTMLElement>('[data-testid="start"]');

    expect(settingsButton?.getAttribute('size')).toBe('sm');
    expect(settingsButton?.getAttribute('variant')).toBe('ghost');
    expect(settingsButton?.querySelector('mndw-icon[name="settings"]')).not.toBeNull();
    expect(historyButton?.getAttribute('size')).toBe('sm');
    expect(historyButton?.getAttribute('variant')).toBe('ghost');
    expect(start?.getAttribute('variant')).toBe('primary');
    expect(start?.closest('.gauge-wrap')).toBeNull();
    expect(start?.closest('.action-row')).not.toBeNull();
    expect(server?.textContent).toBe('spd-fisrv.hostkey.com:5201');
    expect(server?.getAttribute('title')).toBe('spd-fisrv.hostkey.com:5201');
    expect(widget.target.querySelector('footer')).toBeNull();
    expect(widget.target.querySelector('header .phase-label')).toBeNull();
    expect(widget.target.querySelector('.action-status')).not.toBeNull();
    expect(widget.target.textContent).toContain('spd-fisrv.hostkey.com');
    expect(widget.target.textContent).toContain('Start');
    expect(widget.target.textContent).not.toContain('Ready to test');
    expect(widget.target.querySelector('.status')).toBeNull();
    click(widget.target, '[data-testid="start"]');

    expect(widget.target.querySelector('[data-testid="stop"]')?.closest('.action-row'))
      .toBe(widget.target.querySelector('.action-row'));

    expect(widget.socket.sent).toEqual([
      JSON.stringify({
        type: 'start',
        host: 'spd-fisrv.hostkey.com',
        portFrom: 5201,
        portTo: 5209,
        duration: 10,
        streams: 4,
      }),
    ]);
  });

  it('keeps the completed status when the socket closes after a run', async () => {
    const widget = createWidget();

    await ready(widget);
    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'done'});

    const status = widget.target.querySelector('.action-status');

    expect(status?.textContent).toBe('Test complete');
    widget.socket.close();

    expect(status?.textContent).toBe('Test complete');
  });

  it('uses distinct empty chart text', async () => {
    const widget = createWidget();

    await ready(widget);

    const chart = widget.target.querySelector('mndw-line-chart') as
      | (HTMLElement & {emptyLabel?: string})
      | null;

    expect(widget.target.querySelector('.chart-box')).not.toBeNull();
    expect(chart?.emptyLabel).toBe('Speed per second appears here');
    expect(chart?.valueTicks).toBe(2);
    expect(chart?.valueAxis).toBe(true);
  });

  it('uses the Russian localized seconds unit on the chart axis', async () => {
    const widget = createWidget('ru');

    await ready(widget);

    const chart = widget.target.querySelector('mndw-line-chart') as
      | (HTMLElement & {timeFormatter?: (value: number) => string})
      | null;

    expect(chart?.timeFormatter?.(5)).toBe('5 с');
  });

  it('renders phases, live readings and results, then saves a completed history item', async () => {
    const widget = createWidget();

    await ready(widget);
    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'phase', phase: 'download', port: 5201});
    widget.socket.emit({type: 'interval', phase: 'download', second: 1, bitsPerSecond: 412_000_000});
    widget.socket.emit({type: 'result', phase: 'download', bitsPerSecond: 412_000_000});
    widget.socket.emit({type: 'phase', phase: 'upload', port: 5201});
    widget.socket.emit({type: 'interval', phase: 'upload', second: 1, bitsPerSecond: 188_000_000});
    widget.socket.emit({type: 'result', phase: 'upload', bitsPerSecond: 188_000_000});
    widget.socket.emit({type: 'phase', phase: 'ping', port: 5201});
    widget.socket.emit({type: 'ping', pingMs: 7, jitterMs: 1});
    widget.socket.emit({type: 'done'});
    await ready(widget);

    expect(widget.target.textContent).toContain('Download');
    expect(widget.target.textContent).toContain('412 Mbit/s');
    expect(widget.target.textContent).toContain('188 Mbit/s');
    expect(widget.target.textContent).toContain('7 ms');
    expect(widget.target.querySelector('.results dd.download-value')?.textContent).toBe('412 Mbit/s');
    expect(widget.target.querySelector('.results dd.upload-value')?.textContent).toBe('188 Mbit/s');
    expect(widget.target.querySelector('.results dd:not(.download-value):not(.upload-value)')?.textContent).toBe(
      '7 ms',
    );
    expect(widget.target.querySelector('[data-testid="gauge"]')?.getAttribute('data-speed-bps')).toBe('0');
    expect(widget.target.querySelector('[data-testid="gauge-fill"]')?.getAttribute('stroke-dasharray')).toBe(
      '0 100',
    );
    expect(widget.target.querySelector('[data-testid="start"]')?.closest('.action-row')).not.toBeNull();

    const chart = widget.target.querySelector('mndw-line-chart') as
      | (HTMLElement & {
        valueLabel?: string;
        valueFormatter?: (value: number) => string;
        timeFormatter?: (value: number) => string;
      })
      | null;

    expect(chart?.valueLabel).toBe('Speed');
    expect(chart?.valueFormatter?.(412_000_000)).toBe('412 Mbit/s');
    expect(chart?.timeFormatter?.(5)).toBe('5 s');
    expect(JSON.parse((await widget.storage.get('history')) ?? '[]')).toEqual([
      expect.objectContaining({
        server: 'spd-fisrv.hostkey.com:5201',
        pingMs: 7,
        jitterMs: 1,
        downloadBps: 412_000_000,
        uploadBps: 188_000_000,
      }),
    ]);
  });

  it('sends Stop and keeps finished phase results after stopped', async () => {
    const widget = createWidget();

    await ready(widget);
    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'phase', phase: 'download', port: 5201});
    widget.socket.emit({type: 'result', phase: 'download', bitsPerSecond: 412_000_000});
    click(widget.target, '[data-testid="stop"]');
    widget.socket.emit({type: 'stopped'});

    expect(widget.socket.sent.at(-1)).toBe(JSON.stringify({type: 'stop'}));
    expect(widget.target.textContent).toContain('412 Mbit/s');
    expect(widget.target.textContent).toContain('Test stopped');
    expect(widget.target.querySelector('[data-testid="start"]')?.closest('.action-row')).not.toBeNull();
  });

  it('shows ping bars after download and upload, then restores the zeroed gauge after done', async () => {
    const widget = createWidget();

    await ready(widget);
    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'phase', phase: 'download', port: 5201});
    widget.socket.emit({type: 'interval', phase: 'download', second: 1, bitsPerSecond: 300_000_000});
    expect(widget.target.querySelector('[data-testid="gauge"]')).not.toBeNull();

    const gaugeCopy = widget.target.querySelector('.gauge-copy');

    expect(gaugeCopy?.children[0]?.classList.contains('speed')).toBe(true);
    expect(gaugeCopy?.children[1]?.classList.contains('phase')).toBe(true);
    widget.socket.emit({type: 'phase', phase: 'upload', port: 5201});
    expect(widget.target.querySelector('[data-testid="gauge"]')?.getAttribute('data-speed-bps')).toBe('0');
    expect(widget.target.querySelector('[data-testid="gauge-fill"]')?.getAttribute('stroke-dasharray')).toBe(
      '0 100',
    );
    widget.socket.emit({type: 'interval', phase: 'upload', second: 1, bitsPerSecond: 200_000_000});
    widget.socket.emit({type: 'interval', phase: 'upload', second: 2, bitsPerSecond: 150_000_000});
    expect(widget.target.querySelector('[data-testid="gauge"]')?.getAttribute('data-speed-bps'))
      .toBe('150000000');

    const samples = [12, 15, null, 18, 13, 17, 19, 11, 16, 14] as const;

    widget.socket.emit({type: 'phase', phase: 'ping', port: 5201});

    for (const [index, ms] of samples.entries()) {
      widget.socket.emit({type: 'pingSample', index, ms});
    }

    await ready(widget);

    const chart = widget.target.querySelector('mndw-bar-chart') as
      | (HTMLElement & {
        points?: Array<{time: number; value: number}>;
        valueLabel?: string;
        valueFormatter?: (value: number) => string;
      })
      | null;

    expect(widget.target.querySelector('[data-testid="gauge"]')).toBeNull();
    expect(widget.target.querySelector('.gauge-box')).not.toBeNull();
    expect(chart?.closest('.gauge-box')).not.toBeNull();
    expect(chart?.points?.map((point) => point.value)).toEqual([12, 15, 0, 18, 13, 17, 19, 11, 16, 14]);
    expect(chart?.points).toHaveLength(10);
    expect(chart?.valueLabel).toBe('Ping');
    expect(chart?.valueFormatter?.(12)).toBe('12 ms');
    expect(chart?.style.position).toBe('absolute');
    expect(chart?.getAttribute('style')).toContain('inset: 0');
    expect(chart?.shadowRoot?.querySelectorAll('[data-bar]')).toHaveLength(10);
    expect(chart?.shadowRoot?.querySelector('[data-bar][height="0"]')).not.toBeNull();

    widget.socket.emit({type: 'done'});
    await ready(widget);

    expect(widget.target.querySelector('mndw-bar-chart')).toBeNull();
    expect(widget.target.querySelector('[data-testid="gauge"]')?.getAttribute('data-speed-bps')).toBe('0');
  });

  it('resets the gauge when a download phase starts after another active phase', async () => {
    const widget = createWidget();

    await ready(widget);
    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'phase', phase: 'upload', port: 5201});
    widget.socket.emit({type: 'interval', phase: 'upload', second: 1, bitsPerSecond: 102_500_000});
    widget.socket.emit({type: 'phase', phase: 'download', port: 5201});

    expect(widget.target.querySelector('[data-testid="gauge"]')?.getAttribute('data-speed-bps')).toBe('0');
    expect(widget.target.querySelector('[data-testid="gauge-fill"]')?.getAttribute('stroke-dasharray')).toBe(
      '0 100',
    );
  });

  it('keeps gauge, action and chart zones reserved from idle through running to done', async () => {
    const widget = createWidget();

    await ready(widget);

    const zones = ['.gauge-box', '.action-row', '.chart-box'];
    const getZoneClasses = (): string[] =>
      zones.map((selector) => {
        const zone = widget.target.querySelector<HTMLElement>(selector);

        expect(zone).not.toBeNull();

        return zone?.className ?? '';
      });
    const idleClasses = getZoneClasses();

    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'phase', phase: 'download', port: 5201});
    widget.socket.emit({type: 'interval', phase: 'download', second: 1, bitsPerSecond: 102_500_000});
    flushSync();

    expect(getZoneClasses()).toEqual(idleClasses);
    expect(widget.target.querySelector('[data-testid="stop"]')?.closest('.action-row'))
      .toBe(widget.target.querySelector('.action-row'));
    widget.socket.emit({type: 'done'});
    flushSync();

    expect(getZoneClasses()).toEqual(idleClasses);
    expect(widget.target.querySelector('[data-testid="start"]')?.closest('.action-row'))
      .toBe(widget.target.querySelector('.action-row'));
  });

  it('sets the ping chart domain to 100 ms until a sample exceeds it, then rounds up by 50 ms', async () => {
    const widget = createWidget();

    await ready(widget);
    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'phase', phase: 'ping', port: 5201});
    widget.socket.emit({type: 'pingSample', index: 0, ms: 30});
    widget.socket.emit({type: 'pingSample', index: 1, ms: 40});

    let chart = widget.target.querySelector('mndw-bar-chart') as
      | (HTMLElement & {valueDomain?: {min: number; max: number}})
      | null;

    expect(chart?.valueDomain).toEqual({min: 0, max: 100});
    widget.socket.emit({type: 'pingSample', index: 2, ms: 140});

    chart = widget.target.querySelector('mndw-bar-chart') as
      | (HTMLElement & {valueDomain?: {min: number; max: number}})
      | null;

    expect(chart?.valueDomain).toEqual({min: 0, max: 150});
  });

  it('saves null ping and jitter results and displays em dashes', async () => {
    const widget = createWidget();

    await ready(widget);
    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'phase', phase: 'download', port: 5201});
    widget.socket.emit({type: 'result', phase: 'download', bitsPerSecond: 102_500_000});
    widget.socket.emit({type: 'phase', phase: 'upload', port: 5201});
    widget.socket.emit({type: 'result', phase: 'upload', bitsPerSecond: 59_100_000});
    widget.socket.emit({type: 'phase', phase: 'ping', port: 5201});
    widget.socket.emit({type: 'ping', pingMs: null, jitterMs: null});
    widget.socket.emit({type: 'done'});
    await ready(widget);

    const saved = JSON.parse((await widget.storage.get('history')) ?? '[]') as Array<{
      pingMs: number | null;
      jitterMs: number | null;
    }>;

    expect(widget.target.querySelector('[data-testid="results"]')?.textContent).toContain('—');
    expect(saved).toEqual([expect.objectContaining({pingMs: null, jitterMs: null})]);
  });

  it.each(
    [
      ['busy', 'Another test is running'],
      ['server-busy', 'This server is busy'],
      ['unreachable', 'Server unreachable'],
      ['iperf-missing', 'iperf3 is missing'],
      ['invalid-input', 'Settings are invalid'],
      ['iperf-failed', 'Speed test failed'],
    ] as const,
  )('shows the %s error in plain language', async (code, text) => {
    const widget = createWidget();

    await ready(widget);
    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'error', code, message: 'backend detail'});

    expect(widget.target.textContent).toContain(text);
  });

  it('limits live region updates to at most one per second', async () => {
    vi.useFakeTimers();

    const widget = createWidget();

    await ready(widget);
    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'phase', phase: 'download', port: 5201});

    const liveRegion = widget.target.querySelector('[aria-live="polite"]');
    const first = liveRegion?.textContent;

    vi.advanceTimersByTime(500);
    widget.socket.emit({type: 'interval', phase: 'download', second: 1, bitsPerSecond: 412_000_000});

    expect(liveRegion?.textContent).toBe(first);

    vi.advanceTimersByTime(500);
    widget.socket.emit({type: 'interval', phase: 'download', second: 2, bitsPerSecond: 500_000_000});

    expect(liveRegion?.textContent).not.toBe(first);
  });

  it('centers the action button and reserves an empty status line below it while idle', async () => {
    const widget = createWidget();

    await ready(widget);

    const actionRow = widget.target.querySelector<HTMLElement>('.action-row');
    const actionStatus = widget.target.querySelector<HTMLElement>('.action-status');

    expect(actionRow).not.toBeNull();
    expect(actionRow?.style.display).toBe('flex');
    expect(actionRow?.style.justifyContent).toBe('center');
    expect(actionStatus?.textContent?.trim()).toBe('');
    expect(actionStatus?.previousElementSibling).toBe(actionRow);
  });

  it('selects tiers from root content height and disconnects its observer on unmount', async () => {
    const widget = createWidget();

    await ready(widget);
    expect(widget.observer?.observedTarget).toBe(widget.target.querySelector('.widget'));

    widget.resize(354);
    flushSync();
    expect(widget.target.querySelector('.widget')?.classList.contains('tier-full')).toBe(true);

    widget.resize(234);
    flushSync();
    expect(widget.target.querySelector('.widget')?.classList.contains('tier-medium')).toBe(true);

    widget.resize(174);
    flushSync();
    expect(widget.target.querySelector('.widget')?.classList.contains('tier-line')).toBe(true);

    widget.resize(114);
    flushSync();
    expect(widget.target.querySelector('.widget')?.classList.contains('tier-line')).toBe(true);

    widget.resize(54);
    flushSync();
    expect(widget.target.querySelector('.widget')?.classList.contains('tier-line')).toBe(true);

    widget.resize(354);
    flushSync();
    expect(widget.target.querySelector('.widget')?.classList.contains('tier-full')).toBe(true);

    const observer = widget.observer;
    const app = widget.app;

    await unmount(app);
    widget.appUnmounted = true;
    expect(observer?.disconnected).toBe(true);
  });

  it('lets the gauge use remaining height while reserving the fixed chart space', async () => {
    const widget = createWidget();

    await ready(widget);
    widget.resize(354);
    flushSync();

    const gaugeBox = widget.target.querySelector<HTMLElement>('.gauge-box');
    const chartBox = widget.target.querySelector<HTMLElement>('.chart-box');

    expect(gaugeBox?.style.flexGrow).toBe('1');
    expect(gaugeBox?.style.flexShrink).toBe('1');
    expect(gaugeBox?.style.minBlockSize).toBe('0');
    expect(gaugeBox?.style.position).toBe('relative');
    expect(gaugeBox?.style.display).toBe('block');
    expect(chartBox?.style.flexBasis).toBe('6.5rem');
    expect(chartBox?.style.blockSize).toBe('6.5rem');
  });

  it('uses full, two-column medium and line layouts at heights nine, six and four', async () => {
    const widget = createWidget();

    await ready(widget);
    widget.resize(354);
    flushSync();
    expect(widget.target.querySelector('.widget')?.classList.contains('tier-full')).toBe(true);
    expect(widget.target.querySelector('.gauge-box')).not.toBeNull();
    expect(widget.target.querySelector('.chart-box')).not.toBeNull();

    widget.resize(234);
    flushSync();

    expect(widget.target.querySelector('.widget')?.classList.contains('tier-medium')).toBe(true);
    expect(widget.target.querySelector('.gauge-box')).not.toBeNull();
    expect(widget.target.querySelector('mndw-line-chart')).toBeNull();

    const mediumRow = widget.target.querySelector<HTMLElement>('[data-testid="medium-row"]');
    const gaugeBox = widget.target.querySelector<HTMLElement>('.medium-row > .gauge-box');
    const actionZone = widget.target.querySelector<HTMLElement>('.medium-row > .action-zone');
    const mediumResults = widget.target.querySelector<HTMLElement>('.results-row');

    expect(mediumRow).not.toBeNull();
    expect(gaugeBox?.parentElement).toBe(mediumRow);
    expect(actionZone?.parentElement).toBe(mediumRow);
    expect(gaugeBox?.style.flexGrow).toBe('1');
    expect(gaugeBox?.style.flexShrink).toBe('1');
    expect(gaugeBox?.style.flexBasis).toBe('0px');
    expect(mediumResults?.parentElement).toBe(widget.target.querySelector('.widget'));
    expect(mediumRow?.nextElementSibling).toBe(mediumResults);

    widget.resize(174);
    flushSync();

    expect(widget.target.querySelector('.widget')?.classList.contains('tier-line')).toBe(true);
    expect(widget.target.querySelector('[data-testid="gauge"]')).toBeNull();
    expect(widget.target.querySelector('.gauge-box')).toBeNull();
    expect(widget.target.querySelector('mndw-line-chart')).toBeNull();
    expect(widget.target.querySelector('[data-testid="results"]')).not.toBeNull();
    expect(widget.target.querySelector('[data-testid="start"]')?.closest('.line-main')).not.toBeNull();
    expect(widget.target.querySelector('.line-meter')).toBeNull();
    expect(widget.target.querySelector('.line-value')?.style.fontVariantNumeric).toBe('tabular-nums');
    expect(widget.target.querySelector('.line-value')?.style.minInlineSize).toBe('12ch');
    expect(widget.target.querySelector('.line-phase')?.style.minInlineSize).toBe('5rem');
    expect(widget.target.querySelector('.line-action')?.style.minInlineSize).toBe('6.5rem');

    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'phase', phase: 'download', port: 5201});
    widget.socket.emit({type: 'interval', phase: 'download', second: 1, bitsPerSecond: 102_500_000});

    expect(widget.target.querySelector('.line-value')?.textContent).toContain('102.5 Mbit/s');
    expect(widget.target.querySelector('.line-phase')?.textContent).toContain('Download');
    expect(widget.target.querySelector('[data-testid="stop"]')?.closest('.line-main')).not.toBeNull();
    expect(widget.target.querySelector('.line-meter')).toBeNull();
    expect(widget.target.querySelectorAll('.line-results .line-result')).toHaveLength(3);
  });

  it('moves line results below the main row at 174px and inline below the 100px threshold', async () => {
    const widget = createWidget();

    await ready(widget);
    widget.resize(174);
    flushSync();

    expect(widget.target.querySelector<HTMLElement>('.toolbar-actions')?.hidden).toBe(false);
    expect(widget.target.querySelector('.line-layout > .line-results')).not.toBeNull();
    expect(widget.target.querySelector('.line-main > .line-results')).toBeNull();

    const lineMain = widget.target.querySelector<HTMLElement>('.line-main');
    const lineAction = widget.target.querySelector<HTMLElement>('.line-action');

    expect(lineMain?.lastElementChild).toBe(lineAction);

    widget.resize(99);
    flushSync();

    expect(widget.target.querySelector<HTMLElement>('.toolbar-actions')?.hidden).toBe(true);
    expect(widget.target.querySelector<HTMLElement>('.toolbar-actions')?.style.display).toBe('none');

    const inlineResults = widget.target.querySelector('.line-main > .line-results');
    const inlineAction = widget.target.querySelector<HTMLElement>('.line-action');

    expect(inlineResults).not.toBeNull();
    expect(inlineResults?.nextElementSibling).toBe(inlineAction);
    expect(lineMain?.lastElementChild).toBe(inlineAction);
    expect(inlineAction?.style.marginInlineStart).toBe('auto');
    expect(widget.target.querySelector('.line-layout > .line-results')).toBeNull();
  });

  it('reserves line widths for Russian phase, value and start/stop labels', async () => {
    const widget = createWidget('ru');

    await ready(widget);
    widget.resize(174);
    flushSync();

    const value = widget.target.querySelector<HTMLElement>('.line-value');
    const phase = widget.target.querySelector<HTMLElement>('.line-phase');
    const start = widget.target.querySelector<HTMLElement>('[data-testid="start"]');

    expect(value?.style.fontVariantNumeric).toBe('tabular-nums');
    expect(value?.style.minInlineSize).toBe('12ch');
    expect(phase?.style.minInlineSize).toBe('5rem');
    expect(phase?.textContent).toBe('Готово');
    expect(start?.textContent).toBe('Начать');
    expect(start?.style.minInlineSize).toBe('6.5rem');

    click(widget.target, '[data-testid="start"]');
    widget.socket.emit({type: 'phase', phase: 'download', port: 5201});

    const stop = widget.target.querySelector<HTMLElement>('[data-testid="stop"]');

    expect(phase?.textContent).toBe('Загрузка');
    expect(stop?.textContent).toBe('Остановить');
    expect(stop?.style.minInlineSize).toBe('6.5rem');
  });

  it('blocks invalid custom settings and saves valid values per tile', async () => {
    const widget = createWidget();

    await ready(widget);
    click(widget.target, '[data-testid="settings"]');

    const dialog = widget.overlayTargets.at(-1);

    if (!dialog) {
      throw new Error('Settings dialog did not open');
    }

    const server = dialog.querySelector<HTMLElement & {value: string}>('mndw-select');

    if (server) {
      server.value = 'custom';
      server.dispatchEvent(new CustomEvent('mndwchange', {bubbles: true, composed: true, detail: {value: 'custom'}}));
      flushSync();
    }

    await ready(widget);
    expect(server?.value).toBe('custom');
    expect(dialog.querySelectorAll('input, select, button')).toHaveLength(0);
    expect(dialog.querySelectorAll('mndw-field')).toHaveLength(5);

    const actions = dialog.querySelectorAll('.actions mndw-button');

    expect(actions).toHaveLength(2);
    expect(actions[0]?.textContent).toContain('Cancel');
    expect(actions[1]?.textContent).toContain('Save');
    expect(dialog.querySelector('[name="customHost"]')).not.toBeNull();
    setInputValue(dialog, 'customHost', 'https://example.net');
    click(dialog, '[data-testid="save-settings"]');
    await ready(widget);

    expect(dialog.textContent).toContain('Enter a hostname or IP address');
    expect(await widget.storage.get('settings')).toBeNull();

    setInputValue(dialog, 'customHost', 'example.net');
    setInputValue(dialog, 'customPort', '5202');
    setInputValue(dialog, 'duration', '12');
    setInputValue(dialog, 'streams', '3');
    click(dialog, '[data-testid="save-settings"]');
    await ready(widget);

    expect(JSON.parse((await widget.storage.get('settings')) ?? '{}')).toEqual({
      serverId: 'custom',
      customHost: 'example.net',
      customPort: 5202,
      duration: 12,
      streams: 3,
    });
  });
});
