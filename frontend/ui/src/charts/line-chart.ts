import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import * as d3 from 'd3';
import type {NumberValue} from 'd3';
import {buildLineAriaLabel, filterFinitePoints, formatSpeed, getSpeedUpperLimit, resolveDomain} from './chart-utils.js';
import type {MndwChartColor, MndwChartDomain, MndwChartPoint, MndwChartSeries} from './chart-types.js';
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

export const MNDW_LINE_CHART_TAG = 'mndw-line-chart';

interface TooltipSeriesValue {
  label: string;
  value: string;
}

interface TooltipState {
  left: number;
  top: number;
  time: string;
  values: TooltipSeriesValue[];
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
    domain: {attribute: false},
    emptyLabel: {type: String, attribute: 'empty-label'},
  };

  public static styles = [
    chartFrameStyles,
    css`
      .tooltip {
        min-width: 120px;
      }
    `,
  ];

  declare public series: readonly MndwChartSeries[];
  declare public domain: MndwChartDomain | undefined;
  declare public emptyLabel: string | undefined;

  private tooltipState: TooltipState | null = null;
  private lastPointerPosition: [number, number] | null = null;
  private readonly emptyLabelState: LocalizedPropertyState<string | undefined>;
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
    this.domain = undefined;
    this.emptyLabelState = createLocalizedProperty<string | undefined>(this, 'emptyLabel', 'empty-label');
    this.ariaLabelState = createGeneratedAttribute(this, 'aria-label');
  }

  protected override render(): TemplateResult {
    const validSeries = this.series.some((item) => filterFinitePoints(item.data).length > 0);

    return renderChartFrame({
      hasContent: validSeries,
      emptyLabel: this.emptyLabel ?? getMndwUiText('chart.empty'),
      tooltip: this.tooltipState,
      tooltipBody: this.tooltipState === null ? '' : html`
        <div>${this.tooltipState.time}</div>
        ${this.tooltipState.values.map((item) => html`<div>${item.label}: <strong>${item.value}</strong></div>`)}
      `,
    });
  }

  protected override willUpdate(changedProperties: Map<PropertyKey, unknown>): void {
    if (changedProperties.has('series') || changedProperties.has('domain') || changedProperties.has('emptyLabel')) {
      const hasValidSeries = this.series.some((item) => filterFinitePoints(item.data).length > 0);

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
      || changedProperties.has('domain')
      || changedProperties.has('emptyLabel')
      || this.frame.plotElement === null
    ) {
      this.updateAccessibilityLabel();
      this.drawChart();
    }
  }

  public override disconnectedCallback(): void {
    this.lastPointerPosition = null;
    super.disconnectedCallback();
  }

  private updateAccessibilityLabel(): void {
    this.ariaLabelState.setGenerated(buildLineAriaLabel(
      this.series,
      this.emptyLabel ?? getMndwUiText('chart.empty'),
    ));
  }

  private applyLocale(): void {
    this.emptyLabelState.setGenerated(getMndwUiText('chart.empty'));
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
    const validSeries = this.series
      .map((item) => ({...item, data: filterFinitePoints(item.data)}))
      .filter((item) => item.data.length > 0);

    if (svgElement === null || validSeries.length === 0) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const width = size?.width || rect.width || 400;
    const height = size?.height || rect.height || 200;
    const isSmall = width < 400;
    const padding = isSmall
      ? {top: 6, right: 40, bottom: 22, left: 58}
      : {top: 10, right: 60, bottom: 30, left: 72};
    const allPoints = validSeries.flatMap((item) => item.data);
    const resolvedDomain = resolveDomain(allPoints, this.domain);

    if (resolvedDomain === null) {
      return;
    }

    const maxValue = Math.max(...allPoints.map((point) => point.value), 1);
    const upperLimit = getSpeedUpperLimit(maxValue);
    const xScale = d3.scaleTime()
      .domain([new Date(resolvedDomain.start), new Date(resolvedDomain.end)])
      .range([padding.left, Math.max(width - padding.right, padding.left + 1)]);
    const yScale = d3.scaleLinear()
      .domain([0, upperLimit])
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
      .y0(yScale(0))
      .y1((point) => yScale(point.value))
      .curve(d3.curveMonotoneX);

    for (const item of validSeries) {
      const color = colorVariable(item.color);

      if (item.fill) {
        svg.append('path')
          .attr('data-color', item.color)
          .style('fill', `color-mix(in srgb, ${color} 15%, transparent)`)
          .attr('d', areaGenerator(item.data));
      }

      svg.append('path')
        .attr('data-color', item.color)
        .style('fill', 'none')
        .style('stroke', color)
        .attr('stroke-width', 2)
        .attr('d', lineGenerator(item.data));
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
          .tickFormat((value: NumberValue) => value.valueOf() === 0 ? '' : formatSpeed(value.valueOf())),
      );

    yAxis.selectAll('text').attr('font-size', axisFontSize);

    const xAxis = svg.append('g')
      .attr('part', 'axis')
      .attr('transform', `translate(0, ${height - padding.bottom})`)
      .call(
        d3.axisBottom(xScale)
          .tickValues(xScale.domain())
          .tickFormat(d3.timeFormat('%H:%M:%S') as (value: Date | NumberValue) => string),
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
        cursorLine.style('display', 'none');
        this.tooltipState = null;
        this.requestUpdate();

        return;
      }

      this.lastPointerPosition = [mouseX, mouseY];

      const hoverTime = xScale.invert(mouseX);
      const values = validSeries.map((item) => {
        const closest = item.data.reduce((current, point) => {
          return Math.abs(point.time - hoverTime.getTime()) < Math.abs(current.time - hoverTime.getTime())
            ? point
            : current;
        });

        return {
          label: item.label ?? item.id,
          value: formatSpeed(closest.value),
        };
      });

      cursorLine
        .style('display', null)
        .attr('x1', mouseX)
        .attr('x2', mouseX);

      let left = mouseX + 12;
      let top = mouseY - 30;

      if (left + 140 > width) {
        left = mouseX - 152;
      }

      if (top < padding.top) {
        top = padding.top + 4;
      }

      if (top + 60 > height - padding.bottom) {
        top = Math.max(padding.top, height - padding.bottom - 64);
      }

      this.tooltipState = {
        left,
        top,
        time: d3.timeFormat('%H:%M:%S')(hoverTime),
        values,
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
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-line-chart': MndwLineChart;
  }
}
