import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import * as d3 from 'd3';
import type {NumberValue} from 'd3';
import {
  buildBarAriaLabel,
  filterFinitePoints,
  formatClockTime,
  formatSpeed,
  getSpeedUpperLimit,
  resolveChartColor,
} from './chart-utils.js';
import type {MndwChartColor, MndwChartPoint, MndwChartTimeFormatter, MndwChartValueFormatter} from './chart-types.js';
import {ChartFrameController} from './chart-frame-controller.js';
import {chartFrameStyles, renderChartFrame} from './chart-frame.js';
import {getMndwUiText} from '../i18n.js';
import {LocaleController} from '../locale-controller.js';
import {
  type GeneratedAttributeState,
  type LocalizedPropertyState,
  createGeneratedAttribute,
  createLocalizedProperty,
} from '../localized-property.js';

export const MNDW_BAR_CHART_TAG = 'mndw-bar-chart';

interface TooltipState {
  left: number;
  top: number;
  time: string;
  value: string;
}

interface ChartSize {
  width: number;
  height: number;
}

export class MndwBarChart extends LitElement {
  public static override readonly shadowRootOptions: ShadowRootInit = {mode: 'open'};

  public static properties: PropertyDeclarations = {
    points: {attribute: false},
    emptyLabel: {type: String, attribute: 'empty-label'},
    valueLabel: {type: String, attribute: 'value-label'},
    valueFormatter: {attribute: false},
    timeFormatter: {attribute: false},
    color: {type: String, reflect: true},
  };

  public static styles = [
    chartFrameStyles,
    css`
      [part='hover-band'] {
        fill: color-mix(in srgb, var(--mndw-text) 12%, transparent);
        opacity: 0;
        pointer-events: none;
      }

      [part='hover-band'][data-active] {
        opacity: 1;
      }

      .tooltip {
        min-width: 6.25rem;
      }
    `,
  ];

  declare public points: readonly MndwChartPoint[];
  declare public emptyLabel: string | undefined;
  declare public valueLabel: string | undefined;
  declare public valueFormatter: MndwChartValueFormatter;
  declare public timeFormatter: MndwChartTimeFormatter;
  declare public color: MndwChartColor;

  private tooltipState: TooltipState | null = null;
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

    this.points = [];
    this.valueFormatter = formatSpeed;
    this.timeFormatter = formatClockTime;
    this.color = 'accent';
    this.emptyLabelState = createLocalizedProperty<string | undefined>(this, 'emptyLabel', 'empty-label');
    this.valueLabelState = createLocalizedProperty<string | undefined>(this, 'valueLabel', 'value-label');
    this.ariaLabelState = createGeneratedAttribute(this, 'aria-label');
  }

  protected override render(): TemplateResult {
    const hasValidPoints = filterFinitePoints(this.points).length > 0;

    return renderChartFrame({
      hasContent: hasValidPoints,
      emptyLabel: this.emptyLabel ?? getMndwUiText('chart.empty'),
      tooltip: this.tooltipState,
      tooltipBody: this.tooltipState === null ? '' : html`
        <div>${this.tooltipState.time}</div>
        <div>${this.valueLabel ?? getMndwUiText('chart.values')}: <strong>${this.tooltipState.value}</strong></div>
      `,
    });
  }

  protected override willUpdate(changedProperties: Map<PropertyKey, unknown>): void {
    if (
      changedProperties.has('points')
      || changedProperties.has('emptyLabel')
      || changedProperties.has('valueLabel')
      || changedProperties.has('valueFormatter')
      || changedProperties.has('timeFormatter')
      || changedProperties.has('color')
    ) {
      this.tooltipState = null;
    }
  }

  protected override updated(changedProperties: Map<PropertyKey, unknown>): void {
    if (
      changedProperties.has('points')
      || changedProperties.has('emptyLabel')
      || changedProperties.has('valueLabel')
      || changedProperties.has('valueFormatter')
      || changedProperties.has('timeFormatter')
      || changedProperties.has('color')
      || this.frame.plotElement === null
    ) {
      this.updateAccessibilityLabel();
      this.drawChart();
    }
  }

  private updateAccessibilityLabel(): void {
    this.ariaLabelState.setGenerated(buildBarAriaLabel(
      this.points,
      this.valueLabel ?? getMndwUiText('chart.values'),
      this.emptyLabel ?? getMndwUiText('chart.empty'),
      this.valueFormatter,
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

    const hadTooltip = this.tooltipState !== null;

    this.tooltipState = null;

    if (hadTooltip) {
      this.requestUpdate();
    }

    const svgElement = container.querySelector<SVGSVGElement>('svg');
    const validPoints = filterFinitePoints(this.points).sort((first, second) => first.time - second.time);

    if (svgElement === null || validPoints.length === 0) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const width = size?.width || rect.width || 400;
    const height = size?.height || rect.height || 200;
    const isSmall = width < 300;
    const margin = isSmall
      ? {top: 15, right: 10, bottom: 25, left: 50}
      : {top: 20, right: 15, bottom: 30, left: 60};
    const innerWidth = Math.max(width - margin.left - margin.right, 50);
    const innerHeight = Math.max(height - margin.top - margin.bottom, 50);
    const maxValue = Math.max(...validPoints.map((point) => point.value), 1);
    const upperLimit = getSpeedUpperLimit(maxValue);
    const xScale = d3.scaleBand<string>()
      .domain(validPoints.map((_point, index) => String(index)))
      .range([0, innerWidth])
      .padding(0.15);
    const yScale = d3.scaleLinear()
      .domain([0, upperLimit])
      .range([innerHeight, 0]);
    const svg = d3.select(svgElement)
      .attr('width', width)
      .attr('height', height);

    svg.selectAll('*').remove();

    const group = svg.append('g')
      .attr('transform', `translate(${margin.left}, ${margin.top})`);
    const grid = group.append('g')
      .attr('part', 'grid')
      .call(
        d3.axisLeft(yScale)
          .ticks(3)
          .tickSize(-innerWidth)
          .tickFormat(() => ''),
      );

    grid.select('.domain').remove();

    const axisFontSize = isSmall ? 9 : 10;
    const yAxis = group.append('g')
      .attr('part', 'axis')
      .call(
        d3.axisLeft(yScale)
          .ticks(3)
          .tickFormat((value: NumberValue) => this.valueFormatter(value.valueOf())),
      );

    yAxis.selectAll('text').attr('font-size', axisFontSize);
    yAxis.select('.domain').remove();

    const resolvedColor = resolveChartColor(this.color);

    const hoverBand = group.append('rect')
      .attr('part', 'hover-band')
      .attr('y', 0)
      .attr('height', innerHeight);

    for (const [index, point] of validPoints.entries()) {
      const barX = xScale(String(index)) ?? 0;

      group.append('rect')
        .attr('data-bar', 'true')
        .attr('data-color', resolvedColor)
        .attr('x', barX)
        .attr('y', yScale(point.value))
        .attr('width', xScale.bandwidth())
        .attr('height', yScale(0) - yScale(point.value))
        .style('fill', `var(--mndw-${resolvedColor})`);
    }

    const tickCount = Math.min(validPoints.length, 5);
    const tickStep = Math.max(Math.ceil(validPoints.length / tickCount), 1);
    const tickIndices: number[] = [];

    for (let index = 0; index < validPoints.length && tickIndices.length < tickCount; index += tickStep) {
      tickIndices.push(index);
    }

    if (
      tickIndices[tickIndices.length - 1] !== validPoints.length - 1
      && validPoints.length > 1
    ) {
      tickIndices[tickIndices.length - 1] = validPoints.length - 1;
    }

    const xAxis = group.append('g')
      .attr('part', 'axis')
      .attr('transform', `translate(0, ${innerHeight})`);

    xAxis.selectAll('text')
      .data(tickIndices)
      .enter()
      .append('text')
      .attr('x', (index) => (xScale(String(index)) ?? 0) + xScale.bandwidth() / 2)
      .attr('dy', '1.2em')
      .style('text-anchor', 'middle')
      .attr('font-size', axisFontSize - 1)
      .text((index) => {
        const point = validPoints[index];

        return point === undefined ? '' : this.timeFormatter(point.time);
      });

    const overlay = group.append('rect')
      .attr('width', innerWidth)
      .attr('height', innerHeight)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair');

    const updateTooltip = (event: MouseEvent): void => {
      const groupNode = group.node();

      if (groupNode === null) {
        return;
      }

      const [mouseX, mouseY] = d3.pointer(event, groupNode);

      if (mouseX < 0 || mouseX > innerWidth || mouseY < 0 || mouseY > innerHeight) {
        hoverBand.attr('data-active', null);
        this.tooltipState = null;
        this.requestUpdate();

        return;
      }

      const step = xScale.step();
      const firstBarX = xScale(String(0)) ?? 0;
      const bandOffset = (step - xScale.bandwidth()) / 2;
      const index = Math.min(Math.max(Math.floor((mouseX - firstBarX + bandOffset) / step), 0), validPoints.length - 1);
      const point = validPoints[index];

      if (point === undefined) {
        return;
      }

      const barX = xScale(String(index)) ?? 0;
      const bandWidth = step;
      const bandX = Math.max(0, barX - ((bandWidth - xScale.bandwidth()) / 2));

      hoverBand
        .attr('x', bandX)
        .attr('width', Math.min(bandWidth, innerWidth - bandX))
        .attr('data-active', '');

      let left = mouseX + margin.left + 8;
      let top = mouseY - 30;

      if (left + 120 > width) {
        left = mouseX + margin.left - 128;
      }

      if (top < 0) {
        top = 0;
      }

      if (top + 50 > height) {
        top = Math.max(0, height - 50);
      }

      this.tooltipState = {
        left,
        top,
        time: this.timeFormatter(point.time),
        value: this.valueFormatter(point.value),
      };
      this.requestUpdate();
    };

    overlay.on('mousemove.chart', updateTooltip);
    overlay.on('mouseleave.chart', () => {
      hoverBand.attr('data-active', null);
      this.tooltipState = null;
      this.requestUpdate();
    });

    this.frame.setPlot(svgElement, (): void => {
      overlay.on('.chart', null);
    });
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-bar-chart': MndwBarChart;
  }
}
