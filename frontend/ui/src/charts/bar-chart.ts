import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import * as d3 from 'd3';
import type {NumberValue} from 'd3';
import {buildBarAriaLabel, filterFinitePoints, formatSpeed, getSpeedUpperLimit} from './chart-utils.js';
import type {MndwChartPoint} from './chart-types.js';

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

const pointerPosition = (event: MouseEvent, element: SVGGraphicsElement): [number, number] => {
  const rect = element.getBoundingClientRect();

  return [event.clientX - rect.left, event.clientY - rect.top];
};

export class MndwBarChart extends LitElement {
  public static override readonly shadowRootOptions: ShadowRootInit = {mode: 'open'};

  public static properties: PropertyDeclarations = {
    points: {attribute: false},
    emptyLabel: {type: String, attribute: 'empty-label'},
    valueLabel: {type: String, attribute: 'value-label'},
  };

  public static styles = css`
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
      min-width: 100px;
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

  declare public points: readonly MndwChartPoint[];
  declare public emptyLabel: string;
  declare public valueLabel: string;

  private resizeObserver: ResizeObserver | null = null;
  private observedContainer: HTMLElement | null = null;
  private plotElement: SVGSVGElement | null = null;
  private tooltipState: TooltipState | null = null;
  private lastGeneratedAriaLabel: string | null = null;

  constructor() {
    super();

    this.points = [];
    this.emptyLabel = 'No data available';
    this.valueLabel = 'Values';
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('role', 'img');
  }

  protected override render(): TemplateResult {
    const hasValidPoints = filterFinitePoints(this.points).length > 0;

    return html`
      <div class="container" part="container">
        ${
      hasValidPoints
        ? html`<svg part="plot" aria-hidden="true"></svg>`
        : html`<div class="empty" part="empty">${this.emptyLabel}</div>`
    }
        <div
          class="tooltip"
          part="tooltip"
          ?data-visible=${this.tooltipState !== null}
          style=${this.tooltipStyle()}
        >
          ${
      this.tooltipState === null ? '' : html`
            <div>${this.tooltipState.time}</div>
            <div>${this.valueLabel}: <strong>${this.tooltipState.value}</strong></div>
          `
    }
        </div>
      </div>
    `;
  }

  protected override willUpdate(changedProperties: Map<PropertyKey, unknown>): void {
    if (changedProperties.has('points') || changedProperties.has('emptyLabel') || changedProperties.has('valueLabel')) {
      this.tooltipState = null;
    }
  }

  protected override updated(changedProperties: Map<PropertyKey, unknown>): void {
    if (
      changedProperties.has('points')
      || changedProperties.has('emptyLabel')
      || changedProperties.has('valueLabel')
      || this.plotElement === null
    ) {
      this.updateAccessibilityLabel();
      this.drawChart();
    }
  }

  public override disconnectedCallback(): void {
    this.disconnectPlot();

    if (this.resizeObserver !== null) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.observedContainer = null;
    super.disconnectedCallback();
  }

  private tooltipStyle(): string {
    if (this.tooltipState === null) {
      return '';
    }

    return `left: ${this.tooltipState.left}px; top: ${this.tooltipState.top}px;`;
  }

  private updateAccessibilityLabel(): void {
    const current = this.getAttribute('aria-label');

    if (current !== null && current !== this.lastGeneratedAriaLabel) {
      return;
    }

    const next = buildBarAriaLabel(this.points, this.valueLabel, this.emptyLabel);

    if (current !== next) {
      this.setAttribute('aria-label', next);
    }

    this.lastGeneratedAriaLabel = next;
  }

  // eslint-disable-next-line max-lines-per-function -- D3 rendering keeps chart geometry local.
  private drawChart(size?: ChartSize): void {
    const container = this.renderRoot.querySelector<HTMLElement>('.container');

    if (container === null) {
      return;
    }

    this.observeContainer(container);
    this.disconnectPlot();

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
          .tickFormat(formatSpeed as (value: NumberValue) => string),
      );

    yAxis.selectAll('text').attr('font-size', axisFontSize);
    yAxis.select('.domain').remove();

    for (const [index, point] of validPoints.entries()) {
      const barX = xScale(String(index)) ?? 0;

      group.append('rect')
        .attr('data-bar', 'true')
        .attr('data-color', 'accent')
        .attr('x', barX)
        .attr('y', yScale(point.value))
        .attr('width', xScale.bandwidth())
        .attr('height', yScale(0) - yScale(point.value))
        .style('fill', 'var(--mndw-accent)');
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
      .text((index) => d3.timeFormat('%H:%M:%S')(new Date(validPoints[index]?.time ?? 0)));

    const overlay = group.append('rect')
      .attr('width', innerWidth)
      .attr('height', innerHeight)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair');

    const updateTooltip = (event: MouseEvent): void => {
      const [mouseX, mouseY] = pointerPosition(event, group.node() ?? svgElement);

      if (mouseX < 0 || mouseX > innerWidth || mouseY < 0 || mouseY > innerHeight) {
        this.tooltipState = null;
        this.requestUpdate();

        return;
      }

      const index = Math.min(
        Math.max(Math.floor((mouseX / innerWidth) * validPoints.length), 0),
        validPoints.length - 1,
      );
      const point = validPoints[index];

      if (point === undefined) {
        return;
      }

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
        time: d3.timeFormat('%H:%M:%S')(new Date(point.time)),
        value: formatSpeed(point.value),
      };
      this.requestUpdate();
    };

    overlay.on('mousemove.chart', updateTooltip);
    overlay.on('mouseleave.chart', () => {
      this.tooltipState = null;
      this.requestUpdate();
    });

    this.plotElement = svgElement;
  }

  private observeContainer(container: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    if (this.resizeObserver === null) {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];

        this.drawChart(
          entry === undefined
            ? undefined
            : {width: entry.contentRect.width, height: entry.contentRect.height},
        );
      });
    }

    if (this.observedContainer === container) {
      return;
    }

    if (this.observedContainer !== null) {
      this.resizeObserver.unobserve(this.observedContainer);
    }

    this.resizeObserver.observe(container);
    this.observedContainer = container;
  }

  private disconnectPlot(): void {
    if (this.plotElement !== null) {
      d3.select(this.plotElement).on('.chart', null);
      this.plotElement = null;
    }
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-bar-chart': MndwBarChart;
  }
}
