// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {setMndwUiLocale} from '../i18n.js';
import {defineComponents} from '../testing/index.js';
import {MNDW_SPARKLINE_TAG, MndwSparkline} from './sparkline.js';

defineComponents([MNDW_SPARKLINE_TAG, MndwSparkline]);

afterEach(() => {
  setMndwUiLocale('en');
  document.body.innerHTML = '';
});

async function mount(values: number[]): Promise<MndwSparkline> {
  const element = document.createElement(MNDW_SPARKLINE_TAG);

  element.points = values.map((value) => ({value}));
  document.body.append(element);
  await element.updateComplete;

  return element;
}

describe('<mndw-sparkline>', () => {
  it('does not set host attributes during construction and marks the host as an image on connect', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);

    expect(element.hasAttribute('role')).toBe(false);

    document.body.append(element);
    await element.updateComplete;

    expect(element.getAttribute('role')).toBe('img');
  });

  it('renders the empty state and a neutral aria-label with no data', async () => {
    const element = await mount([]);

    expect(element.shadowRoot?.querySelector('[part="empty"]')?.textContent).toContain('No data available');
    expect(element.getAttribute('aria-label')).toBe('No data available');
    expect(element.shadowRoot?.querySelector('svg')).toBeNull();
  });

  it('renders one bar per finite sample and summarizes the series for assistive tech', async () => {
    const element = await mount([10, Number.NaN, 40, 30]);

    const bars = element.shadowRoot?.querySelectorAll('rect.bar');

    expect(bars).toHaveLength(3);
    expect(element.getAttribute('aria-label')).toBe('Values: latest 30%; range 10% to 40%');
  });

  it('creates the bars in the SVG namespace so they actually render', async () => {
    const element = await mount([10, 40, 30]);

    const bar = element.shadowRoot?.querySelector('rect.bar');

    expect(bar?.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  it('renders a start/end time axis when timestamps align with the samples', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);
    const base = Date.parse('2026-08-12T09:00:00');

    element.points = [
      {time: base, value: 10},
      {time: base + 3_000, value: 20},
      {time: base + 6_000, value: 30},
    ];
    document.body.append(element);
    await element.updateComplete;

    const labels = [...(element.shadowRoot?.querySelectorAll('.axis span') ?? [])].map((span) => span.textContent);

    expect(labels).toEqual(['09:00:00', '09:00:06']);
  });

  it('uses an explicit time domain and leaves invalid timed samples empty', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);
    const base = Date.parse('2026-08-12T09:00:00');
    const chart = element as MndwSparkline & {
      timeDomain?: {start: number; end: number};
    };

    chart.timeDomain = {start: base, end: base + 9_000};
    chart.points = [
      {time: base, value: Number.NaN},
      {time: base + 3_000, value: 10},
      {time: base + 6_000, value: 30},
    ];
    document.body.append(element);
    await element.updateComplete;

    const bars = element.shadowRoot?.querySelectorAll('rect.bar');
    const labels = [...(element.shadowRoot?.querySelectorAll('.axis span') ?? [])]
      .map((span) => span.textContent);

    expect(bars).toHaveLength(2);
    expect(bars?.[0]?.getAttribute('x')).toBe('80');
    expect(labels).toEqual(['09:00:00', '09:00:09']);
  });

  it('keeps timestamps paired when an invalid middle sample is removed', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);
    const base = Date.parse('2026-08-12T09:00:00');

    element.points = [
      {time: base, value: 10},
      {time: base + 3_000, value: Number.NaN},
      {time: base + 6_000, value: 30},
    ];
    document.body.append(element);
    await element.updateComplete;

    const labels = [...(element.shadowRoot?.querySelectorAll('.axis span') ?? [])].map((span) => span.textContent);

    expect(labels).toEqual(['09:00:00', '09:00:06']);
  });

  it('omits the axis when normalized samples are not all timed', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);

    element.points = [
      {time: 1, value: 10},
      {time: 2, value: 20},
      {value: 30},
    ];
    document.body.append(element);
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('.axis')).toBeNull();
  });

  it('scales bar height against the configured max', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);

    element.points = [{value: 50}];
    element.max = 200;
    document.body.append(element);
    await element.updateComplete;

    const bar = element.shadowRoot?.querySelector('rect.bar');

    // 50 of 200 -> a quarter of the 28px plot = height 7, growing from the baseline (top at 21).
    expect(bar?.getAttribute('height')).toBe('7');
    expect(bar?.getAttribute('y')).toBe('21');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('uses max 100 for invalid max %s', async (max) => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);

    element.max = max;
    element.points = [{value: 50}];
    document.body.append(element);
    await element.updateComplete;

    const bar = element.shadowRoot?.querySelector('rect.bar');

    expect(bar?.getAttribute('height')).toBe('14');
  });

  it('uses custom presentation formatters in axis, tooltip, and generated accessibility text', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);
    const base = Date.parse('2026-08-12T09:00:00');

    element.valueLabel = 'Temperature';
    element.valueFormatter = (value) => `${value.toFixed(1)} °C`;
    element.timeFormatter = (time) => `T${time}`;
    element.points = [
      {time: base, value: 10},
      {time: base + 3_000, value: 20},
    ];
    document.body.append(element);
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toBe('Temperature: latest 20.0 °C; range 10.0 °C to 20.0 °C');
    expect([...element.shadowRoot?.querySelectorAll('.axis span') ?? []]
      .map((span) => span.textContent)).toEqual([`T${base}`, `T${base + 3_000}`]);

    const svg = element.shadowRoot?.querySelector<SVGSVGElement>('svg');

    if (svg === null || svg === undefined) {
      throw new Error('missing sparkline plot');
    }

    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 240,
      height: 28,
      top: 0,
      right: 240,
      bottom: 28,
      left: 0,
      toJSON: () => ({}),
    });
    svg.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: 239, clientY: 10}));
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.textContent).toContain(`T${base + 3_000}`);
    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.textContent).toContain('20.0 °C');
  });

  it('preserves caller-authored aria-label through data and locale updates', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);

    element.setAttribute('aria-label', 'CPU load history');
    element.points = [{value: 20}];
    document.body.append(element);
    await element.updateComplete;
    setMndwUiLocale('ru');
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toBe('CPU load history');
  });

  it('updates generated value labels when the UI locale changes', async () => {
    const element = await mount([10, 20]);

    expect(element.getAttribute('aria-label')).toContain('Values: latest 20%');

    setMndwUiLocale('ru');
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toContain('Значения: latest 20%');
  });

  it('falls back to accent for an invalid runtime color', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);

    element.color = 'not-a-chart-color' as never;
    element.points = [{value: 10}];
    document.body.append(element);
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('.plot')?.getAttribute('style')).toContain(
      '--spark-fill: var(--mndw-accent)',
    );
  });

  it('frames the bars with a dashed ceiling and baseline', async () => {
    const element = await mount([10, 40, 30]);

    expect(element.shadowRoot?.querySelectorAll('line.frame')).toHaveLength(2);
  });
});
