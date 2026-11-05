// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {html, render} from 'lit';
import {chartFrameStyles, renderChartFrame, tooltipStyle} from './chart-frame.js';

const mount = (options: Parameters<typeof renderChartFrame>[0]): HTMLElement => {
  const host = document.createElement('div');

  render(renderChartFrame(options), host);

  return host;
};

describe('renderChartFrame', () => {
  it('renders the plot svg when hasContent is true', () => {
    const host = mount({hasContent: true, emptyLabel: 'nope', tooltip: null, tooltipBody: ''});

    expect(host.querySelector('svg[part="plot"]')).not.toBeNull();
    expect(host.querySelector('[part="empty"]')).toBeNull();
  });

  it('renders the empty state with the passed label when hasContent is false', () => {
    const host = mount({hasContent: false, emptyLabel: 'No data available', tooltip: null, tooltipBody: ''});

    expect(host.querySelector('svg[part="plot"]')).toBeNull();
    expect(host.querySelector('[part="empty"]')?.textContent).toContain('No data available');
  });

  it('shows the tooltip body and position only when tooltip is non-null', () => {
    const hidden = mount({hasContent: true, emptyLabel: '', tooltip: null, tooltipBody: html`<b>x</b>`});
    const hiddenTip = hidden.querySelector('[part="tooltip"]');

    expect(hiddenTip?.hasAttribute('data-visible')).toBe(false);
    expect(hiddenTip?.querySelector('b')).toBeNull();

    const shown = mount({hasContent: true, emptyLabel: '', tooltip: {left: 12, top: 34}, tooltipBody: html`<b>x</b>`});
    const shownTip = shown.querySelector('[part="tooltip"]');

    expect(shownTip?.hasAttribute('data-visible')).toBe(true);
    expect(shownTip?.getAttribute('style')).toContain('left: 12px');
    expect(shownTip?.getAttribute('style')).toContain('top: 34px');
    expect(shownTip?.querySelector('b')?.textContent).toBe('x');
  });
});

describe('tooltipStyle', () => {
  it('returns an empty string for a null anchor', () => {
    expect(tooltipStyle(null)).toBe('');
  });

  it('formats left/top as px for an anchor', () => {
    expect(tooltipStyle({left: 5, top: 9})).toBe('left: 5px; top: 9px;');
  });
});

describe('chartFrameStyles', () => {
  it('does not pin either chart-specific tooltip min-width (each chart sets its own)', () => {
    // :host carries `min-width: 0`, so assert the per-chart tooltip widths are absent,
    // not that the string `min-width` never appears.
    expect(chartFrameStyles.cssText).toContain('.tooltip');
    expect(chartFrameStyles.cssText).not.toContain('min-width: 100px');
    expect(chartFrameStyles.cssText).not.toContain('min-width: 120px');
  });
});
