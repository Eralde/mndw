import {
  Component,
  ElementRef,
  type OnDestroy,
  type OnInit,
  computed,
  effect,
  input,
  signal,
  viewChild,
} from '@angular/core';
import * as d3 from 'd3';
import type {RrdTick} from '../../types/rci.types';
import {EXPECTED_POINTS, WINDOW_SECONDS, formatSpeed, getSpeedUpperLimit, padData} from '../../utils/chart.utils';

@Component({
  selector: 'tx-rx-rrd-line-chart',
  templateUrl: './rrd-line-chart.component.html',
  styleUrls: ['./rrd-line-chart.component.scss'],
})
export class RrdLineChartComponent implements OnInit, OnDestroy {
  public readonly txData = input<RrdTick[]>([]);
  public readonly rxData = input<RrdTick[]>([]);
  public readonly deviceTime = input<Date | null>(null);

  protected readonly hasData = computed(() => {
    return (this.txData().length > 0 || this.rxData().length > 0)
      && this.deviceTime() !== null;
  });

  protected readonly tooltipVisible = signal(false);
  protected readonly tooltipLeft = signal(0);
  protected readonly tooltipTop = signal(0);
  protected readonly tooltipTime = signal('');
  protected readonly tooltipTx = signal('');
  protected readonly tooltipRx = signal('');

  private readonly containerRef = viewChild<ElementRef<HTMLElement>>('container');

  private resizeObserver: ResizeObserver | null = null;
  private windowMousePos: {clientX: number; clientY: number} | null = null;
  private containerWidth = 400;
  private containerHeight = 200;

  constructor() {
    effect(() => {
      void this.txData();
      void this.rxData();
      void this.deviceTime();
      void this.containerRef();
      this.drawChart();
    });
  }

  public ngOnInit(): void {
    window.addEventListener('mousemove', this.onWindowMouseMove);
  }

  public ngOnDestroy(): void {
    window.removeEventListener('mousemove', this.onWindowMouseMove);

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }

  private onWindowMouseMove = (event: MouseEvent): void => {
    this.windowMousePos = {clientX: event.clientX, clientY: event.clientY};
  };

  private drawChart(): void {
    const el = this.containerRef()?.nativeElement;

    if (!el) {
      return;
    }

    const txData = this.txData();
    const rxData = this.rxData();
    const deviceTime = this.deviceTime();

    if ((txData.length === 0 && rxData.length === 0) || !deviceTime) {
      return;
    }

    const existingSvg = el.querySelector('svg');

    if (existingSvg) {
      existingSvg.remove();
    }

    const rect = el.getBoundingClientRect();

    this.containerWidth = rect.width || 400;
    this.containerHeight = rect.height || 200;

    const svgNode = d3.select(el)
      .insert('svg', '.chart-tooltip')
      .attr('width', this.containerWidth)
      .attr('height', this.containerHeight)
      .node();

    if (!svgNode) {
      return;
    }

    const svg = svgNode;

    const isSmall = this.containerWidth < 400;
    const axisFontSize = isSmall
      ? Math.max(8, Math.min(11, Math.floor(this.containerWidth / 50)))
      : Math.max(10, Math.min(13, Math.floor(this.containerWidth / 50)));
    const padding = isSmall
      ? {top: 6, right: 40, bottom: 22, left: 58}
      : {top: 10, right: 60, bottom: 30, left: 72};

    const paddedTx = padData(txData, EXPECTED_POINTS);
    const paddedRx = padData(rxData, EXPECTED_POINTS);
    const allData = [...paddedTx, ...paddedRx];
    const maxValue = Math.max(...allData.map((d) => d.v), 1);
    const yUpperLimit = getSpeedUpperLimit(maxValue);

    const nowMs = deviceTime.getTime();
    const mostRecentT = Math.max(...allData.map((d) => d.t));

    const xScale = d3.scaleTime()
      .domain([new Date(nowMs - WINDOW_SECONDS * 1000), new Date(nowMs)])
      .range([padding.left, this.containerWidth - padding.right]);

    const yScale = d3.scaleLinear()
      .domain([0, yUpperLimit])
      .range([this.containerHeight - padding.bottom, padding.top]);

    const getPointTime = (d: RrdTick): Date => {
      return new Date(nowMs - (mostRecentT - d.t) * 1000);
    };

    const areaGenerator = d3.area<RrdTick>()
      .x((d: RrdTick) => xScale(getPointTime(d)))
      .y0(yScale(0))
      .y1((d: RrdTick) => yScale(d.v))
      .curve(d3.curveMonotoneX);

    const lineGenerator = d3.line<RrdTick>()
      .x((d: RrdTick) => xScale(getPointTime(d)))
      .y((d: RrdTick) => yScale(d.v))
      .curve(d3.curveMonotoneX);

    const svgSel = d3.select(svg);

    if (paddedTx.length > 0) {
      svgSel.append('path')
        .datum(paddedTx)
        .style('fill', 'color-mix(in srgb, var(--mndw-accent) 15%, transparent)')
        .attr('d', areaGenerator);

      svgSel.append('path')
        .datum(paddedTx)
        .style('fill', 'none')
        .style('stroke', 'var(--mndw-accent)')
        .attr('stroke-width', 2)
        .attr('d', lineGenerator);
    }

    if (paddedRx.length > 0) {
      svgSel.append('path')
        .datum(paddedRx)
        .style('fill', 'color-mix(in srgb, var(--mndw-success) 15%, transparent)')
        .attr('d', areaGenerator);

      svgSel.append('path')
        .datum(paddedRx)
        .style('fill', 'none')
        .style('stroke', 'var(--mndw-success)')
        .attr('stroke-width', 2)
        .attr('d', lineGenerator);
    }

    const yAxis = svgSel.append('g')
      .attr('class', 'grid')
      .call(
        d3.axisLeft(yScale)
          .tickValues(isSmall ? [0, yUpperLimit] : undefined as never)
          .ticks(isSmall ? undefined : 4)
          .tickFormat((d: d3.NumberValue) => d === 0 ? '' : formatSpeed(d.valueOf()) as never)
          .tickSize(-(this.containerWidth - padding.left - padding.right)),
      )
      .attr('transform', `translate(${padding.left}, 0)`);

    yAxis.selectAll('text').attr('font-size', axisFontSize)
      .style('fill', 'var(--mndw-text-subtle)');

    yAxis.selectAll('.tick line').style('stroke', 'var(--mndw-border)')
      .attr('stroke-dasharray', '4,4');
    yAxis.selectAll('.domain').attr('display', 'none');

    const xAxis = svgSel.append('g')
      .attr('class', 'grid')
      .call(
        d3.axisBottom(xScale)
          .tickValues(xScale.domain())
          .tickFormat(d3.timeFormat('%H:%M:%S') as never)
          .tickSize(-(this.containerHeight - padding.top - padding.bottom)),
      )
      .attr('transform', `translate(0, ${this.containerHeight - padding.bottom})`);

    xAxis.selectAll('text').attr('font-size', axisFontSize)
      .style('fill', 'var(--mndw-text-subtle)');
    xAxis.selectAll('.tick line').style('stroke', 'var(--mndw-border)')
      .attr('stroke-dasharray', '4,4');
    xAxis.selectAll('.domain').attr('display', 'none');

    svgSel.append('rect')
      .attr('width', this.containerWidth - padding.left - padding.right)
      .attr('height', this.containerHeight - padding.top - padding.bottom)
      .attr('transform', `translate(${padding.left}, ${padding.top})`)
      .attr('fill', 'transparent');

    const cursorLine = svgSel.append('line')
      .style('stroke', 'var(--mndw-text-subtle)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '2,2')
      .attr('y1', padding.top)
      .attr('y2', this.containerHeight - padding.bottom)
      .style('display', 'none');

    const rtickBisector = d3.bisector((d: RrdTick) => d.t);
    const bisect = (data: RrdTick[], targetT: number): number => rtickBisector.left(data, targetT);

    const updateCursor = (mx: number, my: number): void => {
      if (
        mx < padding.left || mx > this.containerWidth - padding.right
        || my < padding.top || my > this.containerHeight - padding.bottom
      ) {
        cursorLine.style('display', 'none');
        this.tooltipVisible.set(false);

        return;
      }

      const hoverTime = xScale.invert(mx);
      const hoverMs = hoverTime.getTime();
      const hoverT = mostRecentT - (nowMs - hoverMs) / 1000;

      const txI = bisect(paddedTx, hoverT);
      const txClosest = txI > 0 ? paddedTx[Math.min(txI, paddedTx.length - 1)] : paddedTx[0];

      const rxI = bisect(paddedRx, hoverT);
      const rxClosest = rxI > 0 ? paddedRx[Math.min(rxI, paddedRx.length - 1)] : paddedRx[0];

      cursorLine
        .style('display', null)
        .attr('x1', mx)
        .attr('x2', mx);

      this.tooltipTime.set(d3.timeFormat('%H:%M:%S')(hoverTime));
      this.tooltipTx.set(formatSpeed(txClosest?.v ?? 0));
      this.tooltipRx.set(formatSpeed(rxClosest?.v ?? 0));

      let left = mx + 12;
      let top = my - 30;

      if (left + 140 > this.containerWidth) {
        left = mx - 152;
      }

      if (top < padding.top) {
        top = padding.top + 4;
      }

      if (top + 60 > this.containerHeight - padding.bottom) {
        top = this.containerHeight - padding.bottom - 64;
      }

      this.tooltipLeft.set(left);
      this.tooltipTop.set(top);
      this.tooltipVisible.set(true);
    };

    svgSel.on('mousemove', (event: MouseEvent) => {
      const [mx, my] = d3.pointer(event, svg);

      updateCursor(mx, my);
    });

    svgSel.on('mouseleave', () => {
      cursorLine.style('display', 'none');
      this.tooltipVisible.set(false);
    });

    if (this.windowMousePos && el) {
      const containerRect = el.getBoundingClientRect();
      const {clientX, clientY} = this.windowMousePos;

      if (
        clientX >= containerRect.left && clientX <= containerRect.right
        && clientY >= containerRect.top && clientY <= containerRect.bottom
      ) {
        updateCursor(clientX - containerRect.left, clientY - containerRect.top);
      }
    }
  }
}
