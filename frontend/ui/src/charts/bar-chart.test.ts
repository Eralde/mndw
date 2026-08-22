import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {setMndwUiLocale} from '../i18n.js';
import {MNDW_BAR_CHART_TAG, MndwBarChart} from './bar-chart.js';

beforeAll(() => {
  if (!customElements.get(MNDW_BAR_CHART_TAG)) {
    customElements.define(MNDW_BAR_CHART_TAG, MndwBarChart);
  }
});

afterEach(() => {
  setMndwUiLocale('en');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(markup = ''): Promise<MndwBarChart> {
  const element = document.createElement(MNDW_BAR_CHART_TAG);

  if (markup !== '') {
    element.innerHTML = markup;
  }

  document.body.append(element);
  await element.updateComplete;

  return element;
}

const points = [
  {time: 1000, value: 100},
  {time: 2000, value: 200},
];

// eslint-disable-next-line max-lines-per-function -- element behavior cases stay together.
describe('<mndw-bar-chart>', () => {
  it('does not set host attributes during custom-element construction', async () => {
    const element = document.createElement(MNDW_BAR_CHART_TAG);

    expect(element.hasAttribute('role')).toBe(false);

    document.body.append(element);
    await element.updateComplete;

    expect(element.getAttribute('role')).toBe('img');
  });

  it('defaults to the neutral Values label and empty state', async () => {
    const element = await mount();

    expect(element.valueLabel).toBe('Values');
    expect(element.getAttribute('role')).toBe('img');
    expect(element.getAttribute('aria-label')).toBe('No data available');
    expect(element.shadowRoot?.querySelector('[part="empty"]')?.textContent).toContain('No data available');
  });

  it('re-derives the empty-state aria-label when the locale changes', async () => {
    const element = await mount();

    expect(element.getAttribute('aria-label')).toBe('No data available');

    setMndwUiLocale('ru');
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toBe('Нет данных');
  });

  it('binds the documented hyphenated value-label attribute', async () => {
    const element = await mount('<span></span>');

    element.setAttribute('value-label', 'Throughput');
    await element.updateComplete;

    expect(element.valueLabel).toBe('Throughput');
    expect(element.getAttribute('aria-label')).toBe('No data available');

    element.points = points;
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toContain('Throughput: latest 200 b/s');
  });

  it('renders positional accent bars and timestamp labels', async () => {
    const element = await mount();

    element.points = points;
    await element.updateComplete;

    const bars = element.shadowRoot?.querySelectorAll('rect[data-bar]') ?? [];

    expect(bars).toHaveLength(2);
    expect(bars[0]?.getAttribute('data-color')).toBe('accent');
    expect(element.shadowRoot?.textContent).toMatch(/\d\d:\d\d:01/);
    expect(element.getAttribute('aria-label')).not.toMatch(/TX|RX|Traffic/);
  });

  it('ignores malformed points and renders the configured empty label', async () => {
    const element = await mount();

    element.setAttribute('empty-label', 'Nothing to display');
    element.points = [{time: Number.NaN, value: 1}];
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('svg')).toBeNull();
    expect(element.shadowRoot?.querySelector('[part="empty"]')?.textContent).toContain('Nothing to display');
  });

  it('does not expose a time domain property', async () => {
    const element = await mount();

    expect('domain' in element).toBe(false);
  });

  it('shows and clears a tooltip using local plot events', async () => {
    const element = await mount();

    element.points = points;
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

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

  it('uses observer dimensions and disconnects on teardown', async () => {
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

    element.points = points;
    await element.updateComplete;
    callback?.([{contentRect: {width: 299, height: 180}} as ResizeObserverEntry]);

    expect(element.shadowRoot?.querySelector('svg')?.getAttribute('width')).toBe('299');

    element.remove();
    expect(disconnect).toHaveBeenCalledOnce();
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

    element.points = points;
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (!overlay) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 100, clientY: 100}));
    await element.updateComplete;
    callback?.([{contentRect: {width: 299, height: 180}} as ResizeObserverEntry]);

    const refreshedOverlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    refreshedOverlay?.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 100, clientY: 100}));
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.hasAttribute('data-visible')).toBe(true);
  });
});
