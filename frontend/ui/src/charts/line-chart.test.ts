// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {setMndwUiLocale} from '../i18n.js';
import {defineComponents} from '../testing/index.js';
import {MNDW_LINE_CHART_TAG, MndwLineChart} from './line-chart.js';

defineComponents([MNDW_LINE_CHART_TAG, MndwLineChart]);

afterEach(() => {
  setMndwUiLocale('en');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(): Promise<MndwLineChart> {
  const element = document.createElement(MNDW_LINE_CHART_TAG);

  document.body.append(element);
  await element.updateComplete;

  return element;
}

const tooltipText = (element: MndwLineChart): string | undefined => {
  return element.shadowRoot?.querySelector('[part="tooltip"]')?.textContent?.replace(/\s+/g, ' ').trim();
};

const uploadSeries = {
  id: 'upload',
  label: 'Upload',
  color: 'accent' as const,
  fill: true,
  data: [
    {time: 1000, value: 100},
    {time: 2000, value: 200},
  ],
};

const downloadSeries = {
  id: 'download',
  label: 'Download',
  color: 'success' as const,
  data: [
    {time: 1000, value: 50},
    {time: 2000, value: 150},
  ],
};

const temperatureSeries = {
  id: 'temperature',
  label: 'Temperature',
  color: 'warning' as const,
  data: [
    {time: 1000, value: 10},
    {time: 2000, value: 20},
  ],
};

// eslint-disable-next-line max-lines-per-function -- element behavior cases stay together.
describe('<mndw-line-chart>', () => {
  it('does not set host attributes during custom-element construction', async () => {
    const element = document.createElement(MNDW_LINE_CHART_TAG);

    expect(element.hasAttribute('role')).toBe(false);

    document.body.append(element);
    await element.updateComplete;

    expect(element.getAttribute('role')).toBe('img');
  });

  it('renders an empty accessible state by default', async () => {
    const element = await mount();

    expect(element.getAttribute('role')).toBe('img');
    expect(element.shadowRoot?.querySelector('[part="empty"]')?.textContent).toContain('No data available');
    expect(element.getAttribute('aria-label')).toBe('No data available');
  });

  it('updates generated empty labels with the UI locale', async () => {
    const element = await mount();

    setMndwUiLocale('ru');
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="empty"]')?.textContent).toContain('Нет данных');
    expect(element.getAttribute('aria-label')).toBe('Нет данных');
  });

  it('preserves an explicit aria-label', async () => {
    const element = document.createElement(MNDW_LINE_CHART_TAG);

    element.setAttribute('aria-label', 'Interface chart');
    document.body.append(element);
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toBe('Interface chart');
  });

  it('generates generic labels from series data', async () => {
    const element = await mount();

    element.series = [uploadSeries];
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toContain('Upload: latest 200');
    expect(element.valueFormatter(1234.5)).toBe(new Intl.NumberFormat('en').format(1234.5));
    expect(element.getAttribute('aria-label')).not.toMatch(/TX|RX|Traffic/);
  });

  it('uses caller formatters in axes, tooltip, and generated accessibility text', async () => {
    const element = await mount();

    element.valueLabel = 'Temperature';
    element.valueFormatter = (value) => `${value.toFixed(1)} °C`;
    element.timeFormatter = (time) => `T${time}`;
    element.series = [temperatureSeries];
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toContain('Temperature');
    expect(element.getAttribute('aria-label')).toContain('20.0 °C');
    expect([...element.shadowRoot?.querySelectorAll('[part="axis"] text') ?? []]
      .map((node) => node.textContent)).toContain('10.0 °C');

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (!overlay) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 340, clientY: 100}));
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.textContent).toContain('T2000');
    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.textContent).toContain('20.0 °C');
  });

  it('keeps the default tooltip text when no tooltip formatter is set', async () => {
    const element = await mount();

    element.domain = {start: 1000, end: 2000};
    element.timeFormatter = (time) => `T${time}`;
    element.valueFormatter = (value) => `V${value}`;
    element.series = [
      uploadSeries,
      downloadSeries,
      {id: 'invalid', color: 'muted', data: [{time: Number.NaN, value: 500}]},
    ];
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (overlay === null || overlay === undefined) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 340, clientY: 100}));
    await element.updateComplete;

    expect(element.tooltipFormatter).toBeUndefined();
    expect(tooltipText(element)).toBe('T2000 Upload: V200Download: V150');
  });

  it('renders formatter rows and supplies raw samples for every valid series', async () => {
    const element = await mount();
    let received:
      | {time: number; samples: readonly {seriesId: string; label: string; value: number; time: number}[]}
      | null = null;

    element.domain = {start: 1000, end: 2000};
    element.timeFormatter = (time) => `T${time}`;
    element.series = [
      uploadSeries,
      downloadSeries,
      {id: 'invalid', color: 'muted', data: [{time: Number.NaN, value: 500}]},
    ];
    element.tooltipFormatter = (context) => {
      received = context;

      return {
        rows: [{label: 'Combined', value: String(context.samples.reduce((sum, sample) => sum + sample.value, 0))}],
      };
    };
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (overlay === null || overlay === undefined) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 340, clientY: 100}));
    await element.updateComplete;

    const tooltip = element.shadowRoot?.querySelector<HTMLElement>('[part="tooltip"]');

    expect(received).toMatchObject({
      time: 2000,
      samples: [
        {seriesId: 'upload', label: 'Upload', value: 200, time: 2000},
        {seriesId: 'download', label: 'Download', value: 150, time: 2000},
      ],
    });
    expect(tooltip?.textContent?.replace(/\s+/g, ' ').trim()).toBe('T2000 Combined: 350');
    expect(tooltip?.children).toHaveLength(2);
  });

  it('uses a custom formatter title', async () => {
    const element = await mount();

    element.domain = {start: 1000, end: 2000};
    element.series = [uploadSeries];
    element.tooltipFormatter = () => ({title: 'Upload details', rows: [{label: 'Rate', value: 'fast'}]});
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (overlay === null || overlay === undefined) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 340, clientY: 100}));
    await element.updateComplete;

    expect(tooltipText(element)).toBe('Upload details Rate: fast');
  });

  it('renders formatter strings as text', async () => {
    const element = await mount();

    element.domain = {start: 1000, end: 2000};
    element.series = [uploadSeries];
    element.tooltipFormatter = () => ({title: '<i>title</i>', rows: [{label: '<b>x</b>', value: '<img>'}]});
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (overlay === null || overlay === undefined) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 340, clientY: 100}));
    await element.updateComplete;

    const tooltip = element.shadowRoot?.querySelector('[part="tooltip"]');

    expect(tooltip?.textContent?.replace(/\s+/g, ' ').trim()).toBe('<i>title</i> <b>x</b>: <img>');
    expect(tooltip?.querySelector('i, b, img')).toBeNull();
  });

  it('hides only the tooltip when the formatter returns null', async () => {
    const element = await mount();

    element.domain = {start: 1000, end: 2000};
    element.series = [uploadSeries];
    element.tooltipFormatter = () => null;
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (overlay === null || overlay === undefined) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 340, clientY: 100}));
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.hasAttribute('data-visible')).toBe(false);
    expect(element.shadowRoot?.querySelector('line[stroke-dasharray="2,2"]')?.getAttribute('style')).not.toContain(
      'display: none',
    );
  });

  it('logs a formatter error once and falls back to the default tooltip', async () => {
    const element = await mount();
    const error = new Error('format failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    element.domain = {start: 1000, end: 2000};
    element.timeFormatter = (time) => `T${time}`;
    element.series = [uploadSeries];
    element.tooltipFormatter = () => {
      throw error;
    };
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (overlay === null || overlay === undefined) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 340, clientY: 100}));
    await element.updateComplete;

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith('Chart tooltip formatter failed', error);
    expect(tooltipText(element)).toBe('T2000 Upload: 200');

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 330, clientY: 100}));
    await element.updateComplete;
    expect(consoleError).toHaveBeenCalledOnce();

    overlay.dispatchEvent(new MouseEvent('mouseleave', {bubbles: true}));
    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 340, clientY: 100}));
    await element.updateComplete;
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it('measures tooltip bounds when placing a tall tooltip near the plot edge', async () => {
    const element = await mount();

    element.domain = {start: 1000, end: 2000};
    element.series = [uploadSeries];
    element.tooltipFormatter = () => ({
      rows: Array.from({length: 6}, (_, index) => ({label: `Row ${index}`, value: 'value'})),
    });
    await element.updateComplete;

    const tooltip = element.shadowRoot?.querySelector<HTMLElement>('[part="tooltip"]');

    if (tooltip === null || tooltip === undefined) {
      throw new Error('missing chart tooltip');
    }

    const getBounds = vi.spyOn(tooltip, 'getBoundingClientRect').mockReturnValue({
      // eslint-disable-next-line id-blacklist -- DOMRect field required by getBoundingClientRect
      x: 0,
      y: 0,
      width: 180,
      height: 130,
      top: 0,
      right: 180,
      bottom: 130,
      left: 0,
      toJSON: () => ({}),
    });
    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (overlay === null || overlay === undefined) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 340, clientY: 169}));
    await element.updateComplete;

    const left = Number.parseFloat(tooltip.style.left);
    const top = Number.parseFloat(tooltip.style.top);

    expect(getBounds).toHaveBeenCalled();
    expect(left + 180).toBeLessThanOrEqual(400);
    expect(top + 130).toBeLessThanOrEqual(170);
  });

  it('preserves an authored aria-label after data and locale changes', async () => {
    const element = document.createElement(MNDW_LINE_CHART_TAG);

    element.setAttribute('aria-label', 'CPU history');
    document.body.append(element);
    await element.updateComplete;

    element.series = [uploadSeries];
    await element.updateComplete;
    setMndwUiLocale('ru');
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toBe('CPU history');
  });

  it('renders line and optional area paths with token roles', async () => {
    const element = await mount();

    element.series = [uploadSeries, downloadSeries];
    element.domain = {start: 0, end: 3000};
    await element.updateComplete;

    const paths = element.shadowRoot?.querySelectorAll('path[data-color]') ?? [];
    const svg = element.shadowRoot?.querySelector('svg');

    expect(svg).not.toBeNull();
    expect(paths).toHaveLength(3);
    expect(svg?.querySelector('[part="grid"]')).not.toBeNull();
    expect(svg?.querySelector('[part="axis"]')).not.toBeNull();
    expect(paths[0]?.getAttribute('data-color')).toBe('accent');
    expect(paths[2]?.getAttribute('data-color')).toBe('success');
  });

  it('renders bands and leaves invalid points as line gaps', async () => {
    const element = await mount();

    element.series = [{
      ...uploadSeries,
      fill: false,
      data: [{time: 1000, value: 10}, {time: 2000, value: Number.NaN}, {time: 3000, value: 20}],
    }];
    element.bands = [{
      id: 'cpu-range',
      color: 'accent',
      data: [{time: 1000, min: 5, max: 15}, {time: 3000, min: 15, max: 25}],
    }];
    element.valueDomain = {min: 0, max: 100};
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('path[data-band="cpu-range"]')).not.toBeNull();
    expect(element.shadowRoot?.querySelectorAll('path[data-color="accent"]')).toHaveLength(2);
  });

  it('aligns horizontal grid lines with the plot area', async () => {
    const element = await mount();

    element.series = [uploadSeries];
    element.domain = {start: 0, end: 3000};
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="grid"]')?.getAttribute('transform')).toBe('translate(72, 0)');
  });

  it('keeps the cursor line from intercepting plot hover events', async () => {
    const element = await mount();

    element.series = [uploadSeries];
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('line[stroke-dasharray="2,2"]')?.getAttribute('pointer-events')).toBe(
      'none',
    );
  });

  it('ignores malformed points and returns to the empty state when no valid data remains', async () => {
    const element = await mount();

    element.series = [{
      ...uploadSeries,
      data: [
        {time: Number.NaN, value: 100},
        {time: 2000, value: Number.POSITIVE_INFINITY},
      ],
    }];
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('svg')).toBeNull();
    expect(element.shadowRoot?.querySelector('[part="empty"]')?.textContent).toContain('No data available');
  });

  it('shows and clears a tooltip using plot-local pointer events', async () => {
    const element = await mount();

    element.series = [uploadSeries];
    await element.updateComplete;

    const svg = element.shadowRoot?.querySelector('svg');
    const overlay = svg?.querySelector<SVGRectElement>('rect[fill="transparent"]');

    if (!overlay) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 100, clientY: 100}));
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.hasAttribute('data-visible')).toBe(true);

    overlay.dispatchEvent(new MouseEvent('mouseleave', {bubbles: true}));
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.hasAttribute('data-visible')).toBe(false);
  });

  it('detaches the overlay pointer handler on disconnect (no requestUpdate after removal)', async () => {
    const element = await mount();

    element.series = [uploadSeries];
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (!overlay) {
      throw new Error('missing chart pointer overlay');
    }

    element.remove();

    const requestUpdate = vi.spyOn(element, 'requestUpdate');

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 100, clientY: 100}));

    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it('updates the tooltip when data changes while the pointer remains over the plot', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const element = await mount();

    element.series = [uploadSeries];
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    overlay?.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 100, clientY: 100}));
    await element.updateComplete;
    element.series = [downloadSeries];
    await element.updateComplete;
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.hasAttribute('data-visible')).toBe(true);
    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.textContent).toContain('Download');
    expect(addEventListener.mock.calls.some(([type]) => type === 'mousemove')).toBe(false);
  });

  it('resizes through ResizeObserver and tears down observer and plot listeners', async () => {
    type ObserverCallback = (entries: ResizeObserverEntry[]) => void;

    let callback: ObserverCallback | undefined;
    const disconnect = vi.fn();

    class TestResizeObserver {
      constructor(nextCallback: ObserverCallback) {
        callback = nextCallback;
      }

      public observe = vi.fn();
      public unobserve = vi.fn();
      public disconnect = disconnect;
    }

    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const element = await mount();

    element.series = [uploadSeries];
    await element.updateComplete;
    callback?.([{contentRect: {width: 320, height: 180}} as ResizeObserverEntry]);

    expect(element.shadowRoot?.querySelector('svg')?.getAttribute('width')).toBe('320');

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    element.remove();
    expect(disconnect).toHaveBeenCalledOnce();
    overlay?.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 100, clientY: 100}));
    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.hasAttribute('data-visible')).toBe(false);
  });

  it('keeps tooltip rendering valid when a resize redraw follows hover', async () => {
    type ObserverCallback = (entries: ResizeObserverEntry[]) => void;

    let callback: ObserverCallback | undefined;

    class TestResizeObserver {
      constructor(nextCallback: ObserverCallback) {
        callback = nextCallback;
      }

      public observe = vi.fn();
      public unobserve = vi.fn();
      public disconnect = vi.fn();
    }

    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const element = await mount();

    element.series = [uploadSeries];
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (!overlay) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 100, clientY: 100}));
    await element.updateComplete;
    callback?.([{contentRect: {width: 320, height: 180}} as ResizeObserverEntry]);

    const refreshedOverlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    refreshedOverlay?.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 100, clientY: 100}));
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.hasAttribute('data-visible')).toBe(true);
  });
});
