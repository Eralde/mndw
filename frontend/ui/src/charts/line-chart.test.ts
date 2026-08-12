import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {setMndwUiLocale} from '../i18n.js';
import {MNDW_LINE_CHART_TAG, MndwLineChart} from './line-chart.js';

beforeAll(() => {
  if (!customElements.get(MNDW_LINE_CHART_TAG)) {
    customElements.define(MNDW_LINE_CHART_TAG, MndwLineChart);
  }
});

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

    expect(element.getAttribute('aria-label')).toContain('Upload: latest 200 b/s');
    expect(element.getAttribute('aria-label')).not.toMatch(/TX|RX|Traffic/);
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
