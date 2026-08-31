import {afterEach, describe, expect, it, vi} from 'vitest';
import {setMndwUiLocale} from '../i18n.js';
import {defineComponents} from '../testing/index.js';
import {MNDW_HEAT_STRIP_TAG, MndwHeatStrip} from './heat-strip.js';

defineComponents([MNDW_HEAT_STRIP_TAG, MndwHeatStrip]);

afterEach(() => {
  setMndwUiLocale('en');
  document.body.innerHTML = '';
});

async function mount(values: number[]): Promise<MndwHeatStrip> {
  const element = document.createElement(MNDW_HEAT_STRIP_TAG);

  element.points = values.map((value) => ({value}));
  document.body.append(element);
  await element.updateComplete;

  return element;
}

describe('<mndw-heat-strip>', () => {
  it('marks the host as an image only after connect', async () => {
    const element = document.createElement(MNDW_HEAT_STRIP_TAG);

    expect(element.hasAttribute('role')).toBe(false);

    document.body.append(element);
    await element.updateComplete;

    expect(element.getAttribute('role')).toBe('img');
  });

  it('renders the empty state with a neutral aria-label', async () => {
    const element = await mount([]);

    expect(element.shadowRoot?.querySelector('[part="empty"]')?.textContent).toContain('No data available');
    expect(element.shadowRoot?.querySelector('svg')).toBeNull();
  });

  it('renders one SVG-namespaced slice per finite sample and summarizes the series', async () => {
    const element = await mount([5, Number.NaN, 55, 90]);

    const slices = element.shadowRoot?.querySelectorAll('rect.slice');

    expect(slices).toHaveLength(3);
    expect(slices?.[0].namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(element.getAttribute('aria-label')).toBe('Values: latest 90%; range 5% to 90%');
  });

  it('renders a start/end time axis when timestamps align with the samples', async () => {
    const element = document.createElement(MNDW_HEAT_STRIP_TAG);
    const base = Date.parse('2026-08-12T09:42:51');

    element.points = [
      {time: base, value: 5},
      {time: base + 3_000, value: 30},
      {time: base + 189_000, value: 60},
    ];
    document.body.append(element);
    await element.updateComplete;

    const labels = [...(element.shadowRoot?.querySelectorAll('.axis span') ?? [])].map((span) => span.textContent);

    expect(labels).toEqual(['09:42:51', '09:46:00']);
  });

  it('keeps timestamps paired when an invalid middle sample is removed', async () => {
    const element = document.createElement(MNDW_HEAT_STRIP_TAG);
    const base = Date.parse('2026-08-12T09:00:00');

    element.points = [
      {time: base, value: 10},
      {time: base + 3_000, value: Number.NaN},
      {time: base + 6_000, value: 30},
    ];
    document.body.append(element);
    await element.updateComplete;

    const svg = element.shadowRoot?.querySelector<SVGSVGElement>('svg');

    if (svg === null || svg === undefined) {
      throw new Error('missing heat strip plot');
    }

    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 300,
      height: 16,
      top: 0,
      right: 300,
      bottom: 16,
      left: 0,
      toJSON: () => ({}),
    });
    svg.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: 299, clientY: 8}));
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.textContent).toContain('09:00:06');
  });

  it('uses custom presentation formatters in axis, tooltip, and generated accessibility text', async () => {
    const element = document.createElement(MNDW_HEAT_STRIP_TAG);
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
      throw new Error('missing heat strip plot');
    }

    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 300,
      height: 16,
      top: 0,
      right: 300,
      bottom: 16,
      left: 0,
      toJSON: () => ({}),
    });
    svg.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: 299, clientY: 8}));
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.textContent).toContain(`T${base + 3_000}`);
    expect(element.shadowRoot?.querySelector('[part="tooltip"]')?.textContent).toContain('20.0 °C');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('uses max 100 for invalid max %s', async (max) => {
    const element = document.createElement(MNDW_HEAT_STRIP_TAG);

    element.max = max;
    element.points = [{value: 50}];
    document.body.append(element);
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('rect.slice')?.getAttribute('style')).toContain(
      'var(--mndw-util-elevated)',
    );
    expect(element.getAttribute('aria-label')).toContain('latest 50%');
  });

  it('preserves caller-authored aria-label through data and locale updates', async () => {
    const element = document.createElement(MNDW_HEAT_STRIP_TAG);

    element.setAttribute('aria-label', 'Radio utilization history');
    element.points = [{value: 20}];
    document.body.append(element);
    await element.updateComplete;
    setMndwUiLocale('ru');
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toBe('Radio utilization history');
  });

  it('updates generated value labels when the UI locale changes', async () => {
    const element = await mount([10, 20]);

    expect(element.getAttribute('aria-label')).toContain('Values: latest 20%');

    setMndwUiLocale('ru');
    await element.updateComplete;

    expect(element.getAttribute('aria-label')).toContain('Значения: latest 20%');
  });

  it('does not expose the removed parallel arrays', async () => {
    const element = await mount([]);

    expect('values' in element).toBe(false);
    expect('times' in element).toBe(false);
  });

  it('clamps out-of-range samples to the low and critical ends of the scale', async () => {
    const element = await mount([5, 95]);

    const fills = [...(element.shadowRoot?.querySelectorAll('rect.slice') ?? [])].map((slice) =>
      (slice as SVGElement).style.fill
    );

    expect(fills).toEqual(['var(--mndw-util-low)', 'var(--mndw-util-critical)']);
  });

  it('colors samples in 10% buckets: same bucket shares a shade, different buckets differ', async () => {
    const element = await mount([22, 28, 35]);

    const fills = [...(element.shadowRoot?.querySelectorAll('rect.slice') ?? [])].map((slice) =>
      (slice as SVGElement).style.fill
    );

    // 22 and 28 both fall in the 20-30 bucket -> identical color; 35 is the 30-40
    // bucket -> a distinct shade.
    expect(fills[0]).toEqual(fills[1]);
    expect(fills[2]).not.toEqual(fills[0]);
    expect(fills[0]).toContain('color-mix(in srgb, var(--mndw-util-low)');
    expect(fills[0]).toContain('var(--mndw-util-moderate)');
  });
});
