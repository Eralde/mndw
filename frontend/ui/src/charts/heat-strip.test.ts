import {afterEach, describe, expect, it} from 'vitest';
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

  element.values = values;
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
    expect(element.getAttribute('aria-label')).toBe('Utilization heatmap. latest 90%; range 5% to 90%');
  });

  it('renders a start/end time axis when timestamps align with the samples', async () => {
    const element = document.createElement(MNDW_HEAT_STRIP_TAG);
    const base = Date.parse('2026-08-12T09:42:51');

    element.values = [5, 30, 60];
    element.times = [base, base + 3_000, base + 189_000];
    document.body.append(element);
    await element.updateComplete;

    const labels = [...(element.shadowRoot?.querySelectorAll('.axis span') ?? [])].map((span) => span.textContent);

    expect(labels).toEqual(['09:42:51', '09:46:00']);
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
