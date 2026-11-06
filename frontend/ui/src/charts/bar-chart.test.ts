// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {setMndwUiLocale} from '../i18n.js';
import {defineComponents} from '../testing/index.js';
import {MNDW_BAR_CHART_TAG, MndwBarChart} from './bar-chart.js';

defineComponents([MNDW_BAR_CHART_TAG, MndwBarChart]);

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

  it('shades the hovered bar column and clears the band on pointer leave', async () => {
    const element = await mount();

    element.points = points;
    await element.updateComplete;

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (overlay === null || overlay === undefined) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 40, clientY: 30}));
    await element.updateComplete;

    const band = element.shadowRoot?.querySelector<SVGRectElement>('[part="hover-band"]');

    expect(band).not.toBeNull();
    expect(band?.hasAttribute('data-active')).toBe(true);
    expect(String(MndwBarChart.styles)).toContain('color-mix(in srgb, var(--mndw-text) 12%, transparent)');

    overlay.dispatchEvent(new MouseEvent('mouseleave', {bubbles: true}));
    await element.updateComplete;

    expect(band?.hasAttribute('data-active')).toBe(false);
  });

  it('uses the custom time and value formatters for chart surfaces', async () => {
    const element = await mount();

    element.timeFormatter = (time) => `T${time}`;
    element.valueFormatter = (value) => `${value.toFixed(1)} °C`;
    element.valueLabel = 'Temperature';
    element.points = [
      {time: 1000, value: 10},
      {time: 2000, value: 20},
    ];
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toContain('Temperature');
    expect(element.getAttribute('aria-label')).toContain('20.0 °C');
    expect([...element.shadowRoot?.querySelectorAll('[part="axis"] text') ?? []]
      .map((node) => node.textContent)).toContain('T2000');

    const overlay = element.shadowRoot?.querySelector<SVGRectElement>('svg rect[fill="transparent"]');

    if (!overlay) {
      throw new Error('missing chart pointer overlay');
    }

    overlay.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 300, clientY: 100}));
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.textContent).toContain('T2000');
    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.textContent).toContain('20.0 °C');
  });

  it('uses the configured semantic color', async () => {
    const element = await mount();

    element.color = 'warning';
    element.points = [{time: 1000, value: 10}];
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('rect[data-color="warning"]')).not.toBeNull();
  });

  it('falls back to accent for an invalid runtime color', async () => {
    const element = await mount();

    element.color = 'not-a-chart-color' as never;
    element.points = [{time: 1000, value: 10}];
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('rect[data-color="accent"]')).not.toBeNull();
  });

  it('preserves an authored aria-label after data and locale changes', async () => {
    const element = document.createElement(MNDW_BAR_CHART_TAG);

    element.setAttribute('aria-label', 'CPU history');
    document.body.append(element);
    await element.updateComplete;

    element.points = points;
    await element.updateComplete;
    setMndwUiLocale('ru');
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toBe('CPU history');
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

  it('detaches the overlay pointer handler on disconnect (no requestUpdate after removal)', async () => {
    const element = await mount();

    element.points = points;
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

  it('re-renders and re-observes the container after a disconnect/reconnect', async () => {
    type ObserverCallback = (entries: ResizeObserverEntry[]) => void;

    let callback: ObserverCallback = () => {
      throw new Error('stale resize observer callback');
    };
    let constructCount = 0;

    class TestResizeObserver {
      constructor(next: ObserverCallback) {
        constructCount += 1;
        callback = next;
      }
      public observe = vi.fn();
      public unobserve = vi.fn();
      public disconnect = vi.fn();
    }

    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const element = await mount();

    element.points = points;
    await element.updateComplete;
    expect(constructCount).toBe(1);

    // Clear the stale callback: the first observer's closure would still redraw the
    // reconnected element, so leaving it set lets broken code pass. Proving re-observation
    // requires a NEW observer to repopulate `callback`.
    element.remove();
    callback = () => {
      throw new Error('stale resize observer callback');
    };
    document.body.append(element);
    await element.updateComplete; // hostConnected requested an update; flush the redraw

    // Reconnect must have created a second observer (finding #3), and a resize through it
    // must reach drawChart — not through a stale first-mount observer.
    expect(constructCount).toBe(2);

    callback([{contentRect: {width: 321, height: 181}} as ResizeObserverEntry]);
    expect(element.shadowRoot?.querySelector('svg')?.getAttribute('width')).toBe('321');
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
