import {afterEach, describe, expect, it} from 'vitest';
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

  element.values = values;
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
    expect(element.getAttribute('aria-label')).toBe('Sparkline. latest 30%; range 10% to 40%');
  });

  it('creates the bars in the SVG namespace so they actually render', async () => {
    const element = await mount([10, 40, 30]);

    const bar = element.shadowRoot?.querySelector('rect.bar');

    expect(bar?.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  it('renders a start/end time axis when timestamps align with the samples', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);
    const base = Date.parse('2026-08-12T09:00:00');

    element.values = [10, 20, 30];
    element.times = [base, base + 3_000, base + 6_000];
    document.body.append(element);
    await element.updateComplete;

    const labels = [...(element.shadowRoot?.querySelectorAll('.axis span') ?? [])].map((span) => span.textContent);

    expect(labels).toEqual(['09:00:00', '09:00:06']);
  });

  it('omits the axis when timestamps do not match the sample count', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);

    element.values = [10, 20, 30];
    element.times = [1, 2];
    document.body.append(element);
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector('.axis')).toBeNull();
  });

  it('scales bar height against the configured max', async () => {
    const element = document.createElement(MNDW_SPARKLINE_TAG);

    element.values = [50];
    element.max = 200;
    document.body.append(element);
    await element.updateComplete;

    const bar = element.shadowRoot?.querySelector('rect.bar');

    // 50 of 200 -> a quarter of the 28px plot = height 7, growing from the baseline (top at 21).
    expect(bar?.getAttribute('height')).toBe('7');
    expect(bar?.getAttribute('y')).toBe('21');
  });

  it('frames the bars with a dashed ceiling and baseline', async () => {
    const element = await mount([10, 40, 30]);

    expect(element.shadowRoot?.querySelectorAll('line.frame')).toHaveLength(2);
  });
});
