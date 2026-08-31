import {LitElement, type PropertyDeclarations, type SVGTemplateResult, type TemplateResult, css, html, svg} from 'lit';
import type {MndwChartSample, MndwChartTimeFormatter, MndwChartValueFormatter} from './chart-types.js';
import {
  defaultPercentFormatter,
  formatChartRange,
  formatClockTime,
  normalizeChartSamples,
  resolveChartMax,
} from './chart-utils.js';
import {getMndwUiText} from '../i18n.js';
import {LocaleController} from '../locale-controller.js';
import {
  type GeneratedAttributeState,
  type LocalizedPropertyState,
  createGeneratedAttribute,
  createLocalizedProperty,
} from '../localized-property.js';

export const MNDW_HEAT_STRIP_TAG = 'mndw-heat-strip';

interface TooltipState {
  left: number;
  value: number;
  time: string | null;
}

interface UtilizationStop {
  readonly at: number;
  readonly token: string;
}

/**
 * Utilization color scale as gradient stops (percent -> CSS token), low->critical.
 * Colors are interpolated between adjacent stops. Values at/below the first stop
 * clamp to `low`, at/above the last stop clamp to `critical`.
 */
const UTILIZATION_STOPS: readonly UtilizationStop[] = [
  {at: 10, token: 'var(--mndw-util-low)'},
  {at: 25, token: 'var(--mndw-util-moderate)'},
  {at: 40, token: 'var(--mndw-util-elevated)'},
  {at: 55, token: 'var(--mndw-util-high)'},
  {at: 70, token: 'var(--mndw-util-critical)'},
];

const FIRST_STOP = UTILIZATION_STOPS[0];
const LAST_STOP = UTILIZATION_STOPS[UTILIZATION_STOPS.length - 1];

/** Width of each utilization step: samples are bucketed to 0, 10, 20 … before coloring. */
const UTILIZATION_STEP = 10;

const clampPercent = (value: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(value, 0), max);
};

/** Snaps a percent down to its 10% bucket floor (0, 10, 20 … 100). */
const bucketPercent = (percent: number): number => {
  return Math.min(100, Math.floor(percent / UTILIZATION_STEP) * UTILIZATION_STEP);
};

/** Colors the utilization scale for `percent` (0..100), interpolating between stops. */
const sliceColor = (percent: number): string => {
  if (percent <= FIRST_STOP.at) {
    return FIRST_STOP.token;
  }

  if (percent >= LAST_STOP.at) {
    return LAST_STOP.token;
  }

  for (let index = 0; index < UTILIZATION_STOPS.length - 1; index += 1) {
    const lower = UTILIZATION_STOPS[index];
    const upper = UTILIZATION_STOPS[index + 1];

    if (percent <= upper.at) {
      const lowerWeight = Math.round(((upper.at - percent) / (upper.at - lower.at)) * 100);

      return `color-mix(in srgb, ${lower.token} ${lowerWeight}%, ${upper.token})`;
    }
  }

  return LAST_STOP.token;
};

/**
 * Single-row utilization heatmap ("carpet"): a horizontal strip where each
 * sample is a full-height slice colored by its 0..`max` load.
 * Hovering a slice surfaces its value. The label/legend are
 * composed by the consumer alongside it.
 */
export class MndwHeatStrip extends LitElement {
  public static override readonly shadowRootOptions: ShadowRootInit = {mode: 'open'};

  public static properties: PropertyDeclarations = {
    points: {attribute: false},
    max: {type: Number},
    emptyLabel: {type: String, attribute: 'empty-label'},
    valueLabel: {type: String, attribute: 'value-label'},
    valueFormatter: {attribute: false},
    timeFormatter: {attribute: false},
  };

  public static styles = css`
    :host {
      display: block;
      width: 100%;
      color: var(--mndw-text);
      font-family: inherit;
    }

    .plot {
      position: relative;
      width: 100%;
      height: 1rem;
    }

    svg {
      display: block;
      width: 100%;
      height: 100%;
      border-radius: var(--mndw-radius-sm);
    }

    .slice[data-active] {
      stroke: var(--mndw-text);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }

    .empty {
      display: grid;
      height: 1rem;
      place-items: center;
      border: 1px solid var(--mndw-border);
      border-radius: var(--mndw-radius-sm);
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

  declare public points: readonly MndwChartSample[];
  declare public max: number;
  declare public emptyLabel: string | undefined;
  declare public valueLabel: string | undefined;
  declare public valueFormatter: MndwChartValueFormatter;
  declare public timeFormatter: MndwChartTimeFormatter;

  private hoverIndex: number | null = null;
  private readonly emptyLabelState: LocalizedPropertyState<string | undefined>;
  private readonly valueLabelState: LocalizedPropertyState<string | undefined>;
  private readonly ariaLabelState: GeneratedAttributeState;
  private readonly localeController = new LocaleController(this, {
    applyLocale: (): void => {
      this.applyLocale();
    },
  });

  constructor() {
    super();

    this.points = [];
    this.max = 100;
    this.emptyLabel = undefined;
    this.valueLabel = undefined;
    this.valueFormatter = defaultPercentFormatter;
    this.timeFormatter = formatClockTime;
    this.emptyLabelState = createLocalizedProperty<string | undefined>(this, 'emptyLabel', 'empty-label');
    this.valueLabelState = createLocalizedProperty<string | undefined>(this, 'valueLabel', 'value-label');
    this.ariaLabelState = createGeneratedAttribute(this, 'aria-label');
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('role', 'img');
  }

  protected override updated(): void {
    this.ariaLabelState.setGenerated(this.computeAriaLabel());
  }

  protected override render(): TemplateResult {
    const samples = this.samples();

    if (samples.length === 0) {
      return html`
        <div class="container" part="container">
          <div class="empty" part="empty">${this.emptyLabel ?? getMndwUiText('chart.empty')}</div>
        </div>
      `;
    }

    const tooltip = this.tooltipState(samples);

    return html`
      <div class="container" part="container">
        <div class="plot" part="plot">
          <svg
            part="plot"
            viewBox="0 0 ${samples.length} 1"
            preserveAspectRatio="none"
            aria-hidden="true"
            @pointermove=${this.onPointerMove}
            @pointerleave=${this.onPointerLeave}
          >
            ${samples.map((sample, index) => this.renderSlice(sample.value, index))}
          </svg>
          ${
      tooltip === null ? '' : html`
            <div class="tooltip" part="tooltip" style="left: ${tooltip.left}%">${
        tooltip.time === null ? '' : html`${tooltip.time} · `
      }${this.valueFormatter(tooltip.value)}</div>
          `
    }
        </div>
        ${this.renderAxis(samples)}
      </div>
    `;
  }

  private renderAxis(samples: readonly MndwChartSample[]): TemplateResult | '' {
    if (samples.length === 0 || !samples.every((sample) => sample.time !== undefined)) {
      return '';
    }

    const start = samples[0]?.time;
    const end = samples[samples.length - 1]?.time;

    if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)) {
      return '';
    }

    return html`
      <div class="axis" part="axis" aria-hidden="true">
        <span>${this.timeFormatter(start)}</span>
        <span>${this.timeFormatter(end)}</span>
      </div>
    `;
  }

  // Slices use lit's `svg` tag so the `<rect>` stays in the SVG namespace and
  // actually renders inside the plot.
  private renderSlice(value: number, index: number): SVGTemplateResult {
    const max = resolveChartMax(this.max);
    const clamped = clampPercent(value, max);
    const percent = bucketPercent((clamped / max) * 100);

    return svg`
      <rect
        class="slice"
        style=${`fill: ${sliceColor(percent)}`}
        ?data-active=${index === this.hoverIndex}
        x=${index}
        y="0"
        width="1.02"
        height="1"
      ></rect>
    `;
  }

  private tooltipState(samples: readonly MndwChartSample[]): TooltipState | null {
    if (this.hoverIndex === null || this.hoverIndex < 0 || this.hoverIndex >= samples.length) {
      return null;
    }

    const sample = samples[this.hoverIndex];

    if (sample === undefined) {
      return null;
    }

    return {
      left: ((this.hoverIndex + 0.5) / samples.length) * 100,
      value: sample.value,
      time: sample.time === undefined ? null : this.timeFormatter(sample.time),
    };
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const samples = this.samples();

    if (samples.length === 0) {
      return;
    }

    const svgElement = event.currentTarget as SVGSVGElement;
    const rect = svgElement.getBoundingClientRect();

    if (rect.width <= 0) {
      return;
    }

    const fraction = (event.clientX - rect.left) / rect.width;
    const index = Math.min(samples.length - 1, Math.max(0, Math.floor(fraction * samples.length)));

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

  private samples(): MndwChartSample[] {
    return normalizeChartSamples(this.points);
  }

  private computeAriaLabel(): string {
    return formatChartRange(
      this.samples(),
      this.valueLabel ?? getMndwUiText('chart.values'),
      this.valueFormatter,
    ) ?? (this.emptyLabel ?? getMndwUiText('chart.empty'));
  }

  private applyLocale(): void {
    this.emptyLabelState.setGenerated(getMndwUiText('chart.empty'));
    this.valueLabelState.setGenerated(getMndwUiText('chart.values'));
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-heat-strip': MndwHeatStrip;
  }
}
