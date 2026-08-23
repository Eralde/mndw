import {type TemplateResult, css, html} from 'lit';

/** The positioning-only slice of each chart's TooltipState. */
export interface ChartTooltipAnchor {
  left: number;
  top: number;
}

export interface ChartFrameOptions {
  /** True when there is finite data to plot; false renders the empty state. */
  hasContent: boolean;
  /** Resolved empty-state label, e.g. `this.emptyLabel ?? getMndwUiText('chart.empty')`. */
  emptyLabel: string;
  /** The tooltip anchor, or null when hidden. */
  tooltip: ChartTooltipAnchor | null;
  /** Chart-specific tooltip body; only rendered when `tooltip` is non-null. */
  tooltipBody: TemplateResult | '';
}

// min-width is intentionally NOT set here — it is coupled to each chart's tooltip
// placement math, so each chart supplies its own (bar 100px, line 120px).
export const chartFrameStyles = css`
  :host {
    display: block;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    color: var(--mndw-text);
    font-family: inherit;
  }

  .container {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 120px;
  }

  svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .empty {
    display: grid;
    height: 100%;
    min-height: 120px;
    place-items: center;
    color: var(--mndw-text-subtle);
    text-align: center;
  }

  .tooltip {
    position: absolute;
    z-index: 1;
    display: none;
    padding: 4px 8px;
    border: 1px solid var(--mndw-border);
    border-radius: 4px;
    background: var(--mndw-surface-raised);
    color: var(--mndw-text);
    font-size: 11px;
    line-height: 1.4;
    pointer-events: none;
    white-space: nowrap;
  }

  .tooltip[data-visible] {
    display: block;
  }

  [part='grid'] .tick line {
    stroke: var(--mndw-border);
    stroke-dasharray: 4, 4;
  }

  [part='grid'] .domain,
  [part='axis'] .domain {
    display: none;
  }

  [part='grid'] text,
  [part='axis'] text {
    fill: var(--mndw-text-subtle);
  }
`;

export const tooltipStyle = (anchor: ChartTooltipAnchor | null): string => {
  if (anchor === null) {
    return '';
  }

  return `left: ${anchor.left}px; top: ${anchor.top}px;`;
};

export const renderChartFrame = (options: ChartFrameOptions): TemplateResult => {
  return html`
    <div class="container" part="container">
      ${
    options.hasContent
      ? html`<svg part="plot" aria-hidden="true"></svg>`
      : html`<div class="empty" part="empty">${options.emptyLabel}</div>`
  }
      <div
        class="tooltip"
        part="tooltip"
        ?data-visible=${options.tooltip !== null}
        style=${tooltipStyle(options.tooltip)}
      >
        ${options.tooltip === null ? '' : options.tooltipBody}
      </div>
    </div>
  `;
};
