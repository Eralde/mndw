import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import * as d3 from 'd3';
import type {NumberValue} from 'd3';
import {
  buildLineAriaLabel,
  filterFinitePoints,
  formatClockTime,
  formatNumber,
  getNiceUpperLimit,
  resolveDomain,
  splitFinitePoints,
} from './chart-utils.js';
import type {
  MndwChartBand,
  MndwChartBandPoint,
  MndwChartColor,
  MndwChartDomain,
  MndwChartPoint,
  MndwChartSeries,
  MndwChartTimeFormatter,
  MndwChartTooltipContent,
  MndwChartTooltipContext,
  MndwChartTooltipFormatter,
  MndwChartTooltipSample,
  MndwChartValueDomain,
  MndwChartValueFormatter,
} from './chart-types.js';
import {ChartFrameController} from './chart-frame-controller.js';
import {chartFrameStyles, measureChartTooltip, renderChartFrame} from './chart-frame.js';
import {getMndwUiText} from '../i18n.js';
import {LocaleController} from '../locale-controller.js';
import {
  type GeneratedAttributeState,
  type LocalizedPropertyState,
  createGeneratedAttribute,
  createLocalizedProperty,
} from '../localized-property.js';

export const MNDW_LINE_CHART_TAG = 'mndw-line-chart';

interface TooltipSeriesValue {
  label: string;
  value: string;
}

interface TooltipState {
  left: number;
  top: number;
  anchorX: number;
  anchorY: number;
  chartWidth: number;
  topMin: number;
  bottomLimit: number;
  horizontalOffset: number;
  time: string;
  values: TooltipSeriesValue[];
  content?: MndwChartTooltipContent;
}

interface ChartSize {
  width: number;
  height: number;
}

const colorVariable = (color: MndwChartColor): string => {
  return `var(--mndw-${color})`;
};

const pointerPosition = (event: MouseEvent, element: SVGSVGElement): [number, number] => {
  const rect = element.getBoundingClientRect();

  return [event.clientX - rect.left, event.clientY - rect.top];
};

export class MndwLineChart extends LitElement {
  public static override readonly shadowRootOptions: ShadowRootInit = {mode: 'open'};

  public static properties: PropertyDeclarations = {
    series: {attribute: false},
    bands: {attribute: false},
    domain: {attribute: false},
    valueDomain: {attribute: false},
    emptyLabel: {type: String, attribute: 'empty-label'},
    valueLabel: {type: String, attribute: 'value-label'},
    valueFormatter: {attribute: false},
    timeFormatter: {attribute: false},
    tooltipFormatter: {attribute: false},
  };

  public static styles = [
    chartFrameStyles,
    css`
      .tooltip {
        min-width: 7.5rem;
      }
    `,
  ];

  declare public series: readonly MndwChartSeries[];
  declare public bands: readonly MndwChartBand[];
  declare public domain: MndwChartDomain | undefined;
  declare public valueDomain: MndwChartValueDomain | undefined;
  declare public emptyLabel: string | undefined;
  declare public valueLabel: string | undefined;
  declare public valueFormatter: MndwChartValueFormatter;
  declare public timeFormatter: MndwChartTimeFormatter;
  declare public tooltipFormatter: MndwChartTooltipFormatter | undefined;

  private tooltipState: TooltipState | null = null;
  private lastPointerPosition: [number, number] | null = null;
  private formatterErrorLogged = false;
  private readonly emptyLabelState: LocalizedPropertyState<string | undefined>;
  private readonly valueLabelState: LocalizedPropertyState<string | undefined>;
  private readonly ariaLabelState: GeneratedAttributeState;
  private readonly localeController = new LocaleController(this, {
    applyLocale: (): void => {
      this.applyLocale();
    },
  });
  private readonly frame = new ChartFrameController(this, (size): void => {
    this.drawChart(size);
  });

  constructor() {
    super();

    this.series = [];
    this.bands = [];
    this.domain = undefined;
    this.valueFormatter = formatNumber;
    this.timeFormatter = formatClockTime;
    this.emptyLabelState = createLocalizedProperty<string | undefined>(this, 'emptyLabel', 'empty-label');
    this.valueLabelState = createLocalizedProperty<string | undefined>(this, 'valueLabel', 'value-label');
    this.ariaLabelState = createGeneratedAttribute(this, 'aria-label');
  }

  protected override render(): TemplateResult {
    const validSeries = this.series.some((item) => filterFinitePoints(item.data).length > 0)
      || this.bands.some((item) => item.data.length > 0);
    const tooltip = this.tooltipState;

    return renderChartFrame({
      hasContent: validSeries,
      emptyLabel: this.emptyLabel ?? getMndwUiText('chart.empty'),
      tooltip,
      tooltipBody: tooltip === null
        ? ''
        : tooltip.content === undefined
        ? html`
          <div>${tooltip.time}</div>
          ${tooltip.values.map((item) => html`<div>${item.label}: <strong>${item.value}</strong></div>`)}
        `
        : html`
          <div>${tooltip.content.title ?? tooltip.time}</div>
          ${tooltip.content.rows.map((item) => html`<div>${item.label}: <strong>${item.value}</strong></div>`)}
        `,
    });
  }

  protected override willUpdate(changedProperties: Map<PropertyKey, unknown>): void {
    if (
      changedProperties.has('series')
      || changedProperties.has('bands')
      || changedProperties.has('domain')
      || changedProperties.has('valueDomain')
      || changedProperties.has('emptyLabel')
      || changedProperties.has('valueLabel')
      || changedProperties.has('valueFormatter')
      || changedProperties.has('timeFormatter')
      || changedProperties.has('tooltipFormatter')
    ) {
      const hasValidSeries = this.series.some((item) => filterFinitePoints(item.data).length > 0)
        || this.bands.some((item) => item.data.length > 0);

      if (this.lastPointerPosition === null || !hasValidSeries) {
        this.tooltipState = null;
      }

      if (!hasValidSeries) {
        this.lastPointerPosition = null;
      }
    }
  }

  protected override updated(changedProperties: Map<PropertyKey, unknown>): void {
    if (
      changedProperties.has('series')
      || changedProperties.has('bands')
      || changedProperties.has('domain')
      || changedProperties.has('valueDomain')
      || changedProperties.has('emptyLabel')
      || changedProperties.has('valueLabel')
      || changedProperties.has('valueFormatter')
      || changedProperties.has('timeFormatter')
      || changedProperties.has('tooltipFormatter')
      || this.frame.plotElement === null
    ) {
      this.updateAccessibilityLabel();
      this.drawChart();
    }

    this.updateTooltipPosition();
  }

  public override disconnectedCallback(): void {
    this.lastPointerPosition = null;
    this.formatterErrorLogged = false;
    super.disconnectedCallback();
  }

  private updateAccessibilityLabel(): void {
    this.ariaLabelState.setGenerated(buildLineAriaLabel(
      this.series,
      this.emptyLabel ?? getMndwUiText('chart.empty'),
      this.valueFormatter,
      this.valueLabelState.dirty ? this.valueLabel : undefined,
    ));
  }

  private applyLocale(): void {
    this.emptyLabelState.setGenerated(getMndwUiText('chart.empty'));
    this.valueLabelState.setGenerated(getMndwUiText('chart.values'));
  }

  // eslint-disable-next-line max-lines-per-function -- D3 rendering keeps chart geometry local.
  private drawChart(size?: ChartSize): void {
    const container = this.renderRoot.querySelector<HTMLElement>('.container');

    if (container === null) {
      return;
    }

    this.frame.observeContainer(container);
    this.frame.disconnectPlot();

    const svgElement = container.querySelector<SVGSVGElement>('svg');
    const validSeries = this.series.filter((item) => filterFinitePoints(item.data).length > 0);
    const validBands = this.bands.filter((item) => item.data.length > 0);

    if (svgElement === null || (validSeries.length === 0 && validBands.length === 0)) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const width = size?.width || rect.width || 400;
    const height = size?.height || rect.height || 200;
    const isSmall = width < 400;
    const padding = isSmall
      ? {top: 6, right: 40, bottom: 22, left: 58}
      : {top: 10, right: 60, bottom: 30, left: 72};
    const allPoints = validSeries.length > 0
      ? validSeries.flatMap((item) => filterFinitePoints(item.data))
      : validBands.flatMap((item) => item.data.map((point) => ({time: point.time, value: point.max})));
    const resolvedDomain = resolveDomain(allPoints, this.domain);

    if (resolvedDomain === null) {
      return;
    }

    const maxValue = Math.max(...allPoints.map((point) => point.value), 1);
    const lowerLimit = this.valueDomain?.min ?? 0;
    const upperLimit = this.valueDomain?.max ?? getNiceUpperLimit(maxValue);
    const xScale = d3.scaleTime()
      .domain([new Date(resolvedDomain.start), new Date(resolvedDomain.end)])
      .range([padding.left, Math.max(width - padding.right, padding.left + 1)]);
    const yScale = d3.scaleLinear()
      .domain([lowerLimit, upperLimit])
      .range([Math.max(height - padding.bottom, padding.top + 1), padding.top]);
    const axisFontSize = isSmall
      ? Math.max(8, Math.min(11, Math.floor(width / 50)))
      : Math.max(10, Math.min(13, Math.floor(width / 50)));
    const svg = d3.select(svgElement)
      .attr('width', width)
      .attr('height', height);

    svg.selectAll('*').remove();

    const lineGenerator = d3.line<MndwChartPoint>()
      .x((point) => xScale(point.time))
      .y((point) => yScale(point.value))
      .curve(d3.curveMonotoneX);
    const areaGenerator = d3.area<MndwChartPoint>()
      .x((point) => xScale(point.time))
      .y0(yScale(lowerLimit))
      .y1((point) => yScale(point.value))
      .curve(d3.curveMonotoneX);

    for (const item of validSeries) {
      const color = colorVariable(item.color);
      const segments = item.segments?.map((segment) => filterFinitePoints(segment.data))
        ?? splitFinitePoints(item.data);

      for (const segment of segments.filter((candidate) => candidate.length > 0)) {
        if (item.fill) {
          svg.append('path')
            .attr('data-color', item.color)
            .style('fill', `color-mix(in srgb, ${color} 15%, transparent)`)
            .attr('d', areaGenerator(segment));
        }

        svg.append('path')
          .attr('data-color', item.color)
          .style('fill', 'none')
          .style('stroke', color)
          .attr('stroke-width', 2)
          .attr('d', lineGenerator(segment));
      }
    }

    for (const band of validBands) {
      const bandArea = d3.area<MndwChartBandPoint>()
        .x((point) => xScale(point.time))
        .y0((point) => yScale(point.min))
        .y1((point) => yScale(point.max))
        .curve(d3.curveMonotoneX);

      svg.append('path')
        .attr('data-band', band.id)
        .style('fill', `color-mix(in srgb, ${colorVariable(band.color)} 15%, transparent)`)
        .attr('d', bandArea(band.data));
    }

    const yGrid = svg.append('g')
      .attr('part', 'grid')
      .attr('transform', `translate(${padding.left}, 0)`)
      .call(
        d3.axisLeft(yScale)
          .ticks(isSmall ? 2 : 4)
          .tickFormat(() => '')
          .tickSize(-(width - padding.left - padding.right)),
      );

    yGrid.selectAll('text').attr('font-size', axisFontSize);

    const yAxis = svg.append('g')
      .attr('part', 'axis')
      .attr('transform', `translate(${padding.left}, 0)`)
      .call(
        d3.axisLeft(yScale)
          .ticks(isSmall ? 2 : 4)
          .tickFormat((value: NumberValue) => value.valueOf() === 0 ? '' : this.valueFormatter(value.valueOf())),
      );

    yAxis.selectAll('text').attr('font-size', axisFontSize);

    const xAxis = svg.append('g')
      .attr('part', 'axis')
      .attr('transform', `translate(0, ${height - padding.bottom})`)
      .call(
        d3.axisBottom(xScale)
          .tickValues(xScale.domain())
          .tickFormat((value: Date | NumberValue) => {
            const epochMs = value instanceof Date ? value.getTime() : value.valueOf();

            return this.timeFormatter(epochMs);
          }),
      );

    xAxis.selectAll('text').attr('font-size', axisFontSize);

    const overlay = svg.append('rect')
      .attr('x', padding.left)
      .attr('y', padding.top)
      .attr('width', Math.max(width - padding.left - padding.right, 1))
      .attr('height', Math.max(height - padding.top - padding.bottom, 1))
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair');

    const cursorLine = svg.append('line')
      .style('stroke', 'var(--mndw-text-subtle)')
      .attr('pointer-events', 'none')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '2,2')
      .attr('y1', padding.top)
      .attr('y2', height - padding.bottom)
      .style('display', 'none');

    const updateTooltipAtPosition = (mouseX: number, mouseY: number): void => {
      if (
        mouseX < padding.left
        || mouseX > width - padding.right
        || mouseY < padding.top
        || mouseY > height - padding.bottom
      ) {
        this.lastPointerPosition = null;
        this.formatterErrorLogged = false;
        cursorLine.style('display', 'none');
        this.tooltipState = null;
        this.requestUpdate();

        return;
      }

      this.lastPointerPosition = [mouseX, mouseY];

      const hoverTime = xScale.invert(mouseX);
      const samples: MndwChartTooltipSample[] = validSeries.map((item) => {
        const points = filterFinitePoints(item.data);
        const closest = points.reduce((current, point) => {
          return Math.abs(point.time - hoverTime.getTime()) < Math.abs(current.time - hoverTime.getTime())
            ? point
            : current;
        });

        return {
          seriesId: item.id,
          label: item.label ?? item.id,
          value: closest.value,
          time: closest.time,
        };
      });
      const values = samples.map((sample) => ({
        label: sample.label,
        value: this.valueFormatter(sample.value),
      }));

      cursorLine
        .style('display', null)
        .attr('x1', mouseX)
        .attr('x2', mouseX);

      const context: MndwChartTooltipContext = {time: hoverTime.getTime(), samples};
      const content = this.formatTooltip(context);

      if (content === null) {
        this.tooltipState = null;
        this.requestUpdate();

        return;
      }

      this.tooltipState = {
        left: mouseX + 12,
        top: mouseY - 30,
        anchorX: mouseX,
        anchorY: mouseY,
        chartWidth: width,
        topMin: padding.top,
        bottomLimit: height - padding.bottom,
        horizontalOffset: 12,
        time: this.timeFormatter(hoverTime.getTime()),
        values,
        ...(content === undefined ? {} : {content}),
      };
      this.requestUpdate();
    };

    const updateTooltip = (event: MouseEvent): void => {
      const [mouseX, mouseY] = pointerPosition(event, svgElement);

      updateTooltipAtPosition(mouseX, mouseY);
    };

    overlay.on('mousemove.chart', updateTooltip);
    overlay.on('mouseleave.chart', () => {
      this.lastPointerPosition = null;
      this.formatterErrorLogged = false;
      cursorLine.style('display', 'none');
      this.tooltipState = null;
      this.requestUpdate();
    });

    this.frame.setPlot(svgElement, (): void => {
      overlay.on('.chart', null);
    });

    if (this.lastPointerPosition !== null) {
      updateTooltipAtPosition(...this.lastPointerPosition);
    }
  }

  private updateTooltipPosition(): void {
    const tooltip = this.renderRoot.querySelector<HTMLElement>('[part="tooltip"][data-visible]');
    const state = this.tooltipState;

    if (tooltip === null || state === null) {
      return;
    }

    const {width, height} = measureChartTooltip(tooltip);
    let left = state.anchorX + state.horizontalOffset;

    if (left + width > state.chartWidth) {
      left = state.anchorX - width - state.horizontalOffset;
    }

    left = Math.max(0, Math.min(left, state.chartWidth - width));

    const maxTop = Math.max(state.topMin, state.bottomLimit - height);
    const top = Math.min(Math.max(state.anchorY - 30, state.topMin), maxTop);

    if (left === state.left && top === state.top) {
      return;
    }

    this.tooltipState = {...state, left, top};
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  private formatTooltip(context: MndwChartTooltipContext): MndwChartTooltipContent | null | undefined {
    const formatter = this.tooltipFormatter;

    if (formatter === undefined) {
      return undefined;
    }

    try {
      const content = formatter(context);

      this.formatterErrorLogged = false;

      return content;
    } catch (error) {
      if (!this.formatterErrorLogged) {
        console.error('Chart tooltip formatter failed', error);
        this.formatterErrorLogged = true;
      }

      return undefined;
    }
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-line-chart': MndwLineChart;
  }
}
