import {LitElement, type PropertyDeclarations, type SVGTemplateResult, type TemplateResult, css, html, svg} from 'lit';
import type {MndwChartColor} from './chart-types.js';
import {formatClockTime} from './chart-utils.js';
import {barIndexAt, computeSparklineBars} from './sparkline-geometry.js';
import {getMndwUiText} from '../i18n.js';
import {LocaleController} from '../locale-controller.js';

export const MNDW_SPARKLINE_TAG = 'mndw-sparkline';

/** Fixed plot height (px) and inter-bar gap, matching the device-info load bar chart. */
const CHART_HEIGHT = 28;
const BAR_GAP = 1;
/** Used before the ResizeObserver reports a real width (first paint, jsdom). */
const FALLBACK_WIDTH = 240;

interface TooltipState {
  left: number;
  value: number;
  time: string | null;
}

interface AlignedSeries {
  values: number[];
  times: (number | null)[];
}

const colorVariable = (color: MndwChartColor): string => {
  return `var(--mndw-${color})`;
};

/**
 * Compact bar sparkline for a 0..`max` percentage series (CPU load, RAM load,
 * etc.). Renders pixel bars growing from a dashed baseline toward a dashed
 * ceiling, and surfaces the hovered sample as a small tooltip. An optional
 * `times` series (epoch-ms, parallel to `values`) adds a start/end time axis and
 * the sample time in the tooltip. The label and current value are composed by
 * the consumer.
 *
 * The host fills its container's height (bars stretch to fill), with a 1.75rem
 * floor so it never collapses when the container has no explicit height.
 */
export class MndwSparkline extends LitElement {
  public static override readonly shadowRootOptions: ShadowRootInit = {mode: 'open'};

  public static properties: PropertyDeclarations = {
    values: {attribute: false},
    times: {attribute: false},
    max: {type: Number},
    color: {type: String},
    emptyLabel: {type: String, attribute: 'empty-label'},
  };

  public static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      color: var(--mndw-text);
      font-family: inherit;
    }

    .container {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }

    .plot {
      position: relative;
      flex: 1 1 auto;
      width: 100%;
      min-height: 1.75rem;
    }

    svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    .bar {
      fill: var(--spark-fill, var(--mndw-accent));
    }

    .bar[data-active] {
      fill: var(--mndw-text);
    }

    .frame {
      stroke: var(--mndw-border);
      stroke-width: 1;
      stroke-dasharray: 2 2;
      vector-effect: non-scaling-stroke;
    }

    .empty {
      display: grid;
      flex: 1 1 auto;
      min-height: 1.75rem;
      place-items: center;
      color: var(--mndw-text-subtle);
      font-size: 0.6875rem;
    }

    .axis {
      display: flex;
      justify-content: space-between;
      margin-top: 0.125rem;
      color: var(--mndw-text-subtle);
      font-size: 0.625rem;
      font-variant-numeric: tabular-nums;
    }

    .tooltip {
      position: absolute;
      bottom: calc(100% + 0.125rem);
      transform: translateX(-50%);
      padding: 0.0625rem 0.3125rem;
      border: 1px solid var(--mndw-border);
      border-radius: 0.1875rem;
      background: var(--mndw-surface-raised);
      color: var(--mndw-text);
      font-size: 0.6875rem;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      pointer-events: none;
    }
  `;

  declare public values: readonly number[];
  declare public times: readonly number[];
  declare public max: number;
  declare public color: MndwChartColor;
  declare public emptyLabel: string | undefined;

  private hoverIndex: number | null = null;
  private chartWidth = 0;
  private resizeObserver: ResizeObserver | null = null;
  private readonly localeController = new LocaleController(this, {
    applyLocale: (): void => {
      this.requestUpdate();
    },
  });

  constructor() {
    super();

    this.values = [];
    this.times = [];
    this.max = 100;
    this.color = 'accent';
    this.emptyLabel = undefined;
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('role', 'img');
    this.observeSize();
  }

  public override disconnectedCallback(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    super.disconnectedCallback();
  }

  protected override updated(): void {
    this.setAttribute('aria-label', this.computeAriaLabel());
  }

  protected override render(): TemplateResult {
    const {values, times} = this.series();

    if (values.length === 0) {
      return html`
        <div class="container" part="container">
          <div class="empty" part="empty">${this.emptyLabel ?? getMndwUiText('chart.empty')}</div>
        </div>
      `;
    }

    const width = this.plotWidth();
    const bars = computeSparklineBars(values, this.max, width, CHART_HEIGHT, BAR_GAP);
    const tooltip = this.tooltipState(bars, times, width);

    return html`
      <div class="container" part="container">
        <div class="plot" style=${`--spark-fill: ${colorVariable(this.color)}`}>
          <svg
            part="plot"
            viewBox="0 0 ${width} ${CHART_HEIGHT}"
            preserveAspectRatio="none"
            aria-hidden="true"
            @pointermove=${this.onPointerMove}
            @pointerleave=${this.onPointerLeave}
          >
            ${bars.map((bar, index) => this.renderBar(bar, index))}
            <line class="frame" x1="0" x2=${width} y1="0.5" y2="0.5"></line>
            <line class="frame" x1="0" x2=${width} y1=${CHART_HEIGHT - 0.5} y2=${CHART_HEIGHT - 0.5}></line>
          </svg>
          ${
      tooltip === null ? '' : html`
            <div class="tooltip" part="tooltip" style="left: ${tooltip.left}px">${
        tooltip.time === null ? '' : html`${tooltip.time} · `
      }${Math.round(tooltip.value)}%</div>
          `
    }
        </div>
        ${this.renderAxis(times)}
      </div>
    `;
  }

  private renderBar(bar: {left: number; top: number; width: number; height: number}, index: number): SVGTemplateResult {
    // `svg` (not `html`): a nested html fragment parses its <rect> in the HTML
    // namespace, where it never renders inside the SVG.
    return svg`
      <rect
        class="bar"
        ?data-active=${index === this.hoverIndex}
        x=${bar.left}
        y=${bar.top}
        width=${bar.width}
        height=${bar.height}
      ></rect>
    `;
  }

  private renderAxis(times: (number | null)[]): TemplateResult | '' {
    const start = times[0];
    const end = times[times.length - 1];

    if (start === null || start === undefined || end === null || end === undefined) {
      return '';
    }

    return html`
      <div class="axis" part="axis" aria-hidden="true">
        <span>${formatClockTime(start)}</span>
        <span>${formatClockTime(end)}</span>
      </div>
    `;
  }

  private tooltipState(
    bars: readonly {left: number; width: number}[],
    times: readonly (number | null)[],
    width: number,
  ): TooltipState | null {
    if (this.hoverIndex === null || this.hoverIndex < 0 || this.hoverIndex >= bars.length) {
      return null;
    }

    const bar = bars[this.hoverIndex];
    const time = times[this.hoverIndex];

    return {
      // The plot stretches its viewBox to the host width, so a viewBox-space center
      // maps to a CSS pixel by the same width scale.
      left: ((bar.left + bar.width / 2) / width) * (this.chartWidth || width),
      value: this.series().values[this.hoverIndex],
      time: time === null || time === undefined ? null : formatClockTime(time),
    };
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const {values} = this.series();

    if (values.length === 0) {
      return;
    }

    const svgElement = event.currentTarget as SVGSVGElement;
    const rect = svgElement.getBoundingClientRect();
    const index = barIndexAt(event.clientX - rect.left, rect.width, values.length);

    if (index !== this.hoverIndex) {
      this.hoverIndex = index;
      this.requestUpdate();
    }
  };

  private readonly onPointerLeave = (): void => {
    if (this.hoverIndex !== null) {
      this.hoverIndex = null;
      this.requestUpdate();
    }
  };

  private observeSize(): void {
    if (typeof ResizeObserver === 'undefined' || this.resizeObserver !== null) {
      return;
    }

    this.resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;

      if (width !== this.chartWidth) {
        this.chartWidth = width;
        this.requestUpdate();
      }
    });
    this.resizeObserver.observe(this);
  }

  private plotWidth(): number {
    return this.chartWidth > 0 ? this.chartWidth : FALLBACK_WIDTH;
  }

  /** Finite samples paired with their timestamps (null where times are absent or misaligned). */
  private series(): AlignedSeries {
    const aligned = this.times.length === this.values.length;
    const values: number[] = [];
    const times: (number | null)[] = [];

    this.values.forEach((value, index) => {
      if (!Number.isFinite(value)) {
        return;
      }

      values.push(value);

      const time = aligned ? this.times[index] : Number.NaN;

      times.push(Number.isFinite(time) ? time : null);
    });

    return {values, times};
  }

  private computeAriaLabel(): string {
    const {values} = this.series();

    if (values.length === 0) {
      return this.emptyLabel ?? getMndwUiText('chart.empty');
    }

    const latest = values[values.length - 1];
    const min = Math.min(...values);
    const max = Math.max(...values);

    return `Sparkline. latest ${Math.round(latest)}%; range ${Math.round(min)}% to ${Math.round(max)}%`;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-sparkline': MndwSparkline;
  }
}
