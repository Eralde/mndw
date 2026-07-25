import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  type OnChanges,
  type OnDestroy,
  Output,
  ViewChild,
} from '@angular/core';
import * as d3 from 'd3';
import type {MwsNode} from '../../domain/mws/mws.types';
import {
  DEFAULT_LAYOUT_CONFIG,
  type GraphLayout,
  type PositionedEdge,
  type PositionedNode,
  layoutForest,
} from './graph-layout';

@Component({
  selector: 'mws-map-graph',
  standalone: true,
  template: '<svg #svg class="mws-graph" role="group" aria-label="MWS topology"></svg>',
  styleUrls: ['./mws-graph.component.scss'],
})
export class MwsGraphComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({required: true})
  public roots: MwsNode[] = [];

  @Output()
  public readonly nodeSelected = new EventEmitter<string>();

  @ViewChild('svg', {static: true})
  private svgRef?: ElementRef<SVGSVGElement>;

  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private zoomGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private fitted = false;

  public ngAfterViewInit(): void {
    const svgElement = this.svgRef?.nativeElement;

    if (svgElement === undefined) {
      return;
    }

    this.svg = d3.select(svgElement);
    this.zoomGroup = this.svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 10])
      .on('zoom', (event) => {
        this.zoomGroup?.attr('transform', event.transform.toString());
      });

    this.svg.call(zoom);

    this.resizeObserver = new ResizeObserver(() => {
      const host = svgElement.parentElement;

      if (host !== null) {
        this.svg?.attr('width', host.clientWidth).attr('height', host.clientHeight);
      }
    });
    this.resizeObserver.observe(svgElement.parentElement ?? svgElement);

    this.render();
  }

  public ngOnChanges(): void {
    this.render();
  }

  public ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.svg?.on('.zoom', null);
  }

  private render(): void {
    const group = this.zoomGroup;

    if (group === null) {
      return;
    }

    const layout = layoutForest(this.roots);

    this.renderEdges(group, layout.edges);
    this.renderNodes(group, layout.nodes);
    this.fitView(layout);
  }

  private edgePath(edge: PositionedEdge): string {
    const half = DEFAULT_LAYOUT_CONFIG.nodeHeight / 2;
    const x1 = edge.source.x;
    const y1 = edge.source.y + half;
    const x2 = edge.target.x;
    const y2 = edge.target.y - half;
    const midY = (y1 + y2) / 2;

    return `M ${x1} ${y1} C ${x1} ${midY} ${x2} ${midY} ${x2} ${y2}`;
  }

  private renderEdges(
    group: d3.Selection<SVGGElement, unknown, null, undefined>,
    edges: PositionedEdge[],
  ): void {
    group.selectAll<SVGPathElement, PositionedEdge>('path.edge')
      .data(edges, (edge) => `${edge.source.node.id}->${edge.target.node.id}`)
      .join('path')
      .attr('class', (edge) => `edge ${edge.type}`)
      .attr('d', (edge) => this.edgePath(edge));
  }

  private renderNodes(
    group: d3.Selection<SVGGElement, unknown, null, undefined>,
    nodes: PositionedNode[],
  ): void {
    const {nodeWidth, nodeHeight} = DEFAULT_LAYOUT_CONFIG;
    const nodeGroups = group.selectAll<SVGGElement, PositionedNode>('g.node')
      .data(nodes, (positioned) => positioned.node.id)
      .join((enter) => {
        const g = enter.append('g');

        g.append('rect');
        g.append('text').attr('class', 'name');
        g.append('text').attr('class', 'model');
        g.append('g').attr('class', 'client-badge')
          .call((badge) => {
            badge.append('circle');
            badge.append('text');
          });
        g.append('circle').attr('class', 'update-dot');

        return g;
      })
      .attr('class', (positioned) => {
        const flags = [
          positioned.node.isController ? 'controller' : '',
          positioned.node.isOnline ? '' : 'offline',
        ].filter((flag) => flag !== '');

        return ['node', ...flags].join(' ');
      })
      .attr('transform', (positioned) => `translate(${positioned.x},${positioned.y})`)
      .attr('role', 'button')
      .attr('tabindex', 0)
      .attr('aria-label', (positioned) => this.nodeLabel(positioned.node))
      .on('click', (_event, positioned) => this.nodeSelected.emit(positioned.node.id))
      .on('keydown', (event: KeyboardEvent, positioned) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.nodeSelected.emit(positioned.node.id);
        }
      });

    nodeGroups.select('rect')
      .attr('x', -nodeWidth / 2)
      .attr('y', -nodeHeight / 2)
      .attr('width', nodeWidth)
      .attr('height', nodeHeight)
      .attr('rx', 6);

    nodeGroups.select('text.name')
      .attr('text-anchor', 'middle')
      .attr('y', -6)
      .text((positioned) => positioned.node.name);

    nodeGroups.select('text.model')
      .attr('text-anchor', 'middle')
      .attr('y', 14)
      .text((positioned) => positioned.node.model ?? '');

    nodeGroups.select('g.client-badge')
      .attr('transform', `translate(${nodeWidth / 2 - 4},${-nodeHeight / 2 + 4})`)
      .style('display', (positioned) => positioned.node.clients.length > 0 ? null : 'none')
      .call((badge) => {
        badge.select('circle').attr('r', 11);
        badge.select('text')
          .attr('text-anchor', 'middle')
          .attr('dy', 4)
          .text((positioned) => positioned.node.clients.length);
      });

    nodeGroups.select('circle.update-dot')
      .attr('cx', -nodeWidth / 2 + 8)
      .attr('cy', -nodeHeight / 2 + 8)
      .attr('r', 4)
      .style('display', (positioned) => {
        const {fw, fwAvailable} = positioned.node;

        return fw !== null && fwAvailable !== null && fw !== fwAvailable ? null : 'none';
      });
  }

  private nodeLabel(node: MwsNode): string {
    const parts = [
      node.name,
      node.model ?? '',
      node.isController ? 'controller' : 'extender',
      node.isOnline ? '' : 'offline',
      `${node.clients.length} clients`,
    ];

    return parts.filter((part) => part !== '').join(', ');
  }

  private fitView(layout: GraphLayout): void {
    if (this.fitted || layout.nodes.length === 0 || this.svg === null) {
      return;
    }

    const {nodeWidth, nodeHeight} = DEFAULT_LAYOUT_CONFIG;
    const pad = 40;
    const xs = layout.nodes.map((positioned) => positioned.x);
    const ys = layout.nodes.map((positioned) => positioned.y);
    const minX = Math.min(...xs) - nodeWidth / 2 - pad;
    const minY = Math.min(...ys) - nodeHeight / 2 - pad;
    const width = Math.max(...xs) - minX + nodeWidth / 2 + pad;
    const height = Math.max(...ys) - minY + nodeHeight / 2 + pad;

    this.svg.attr('viewBox', `${minX} ${minY} ${width} ${height}`);
    this.fitted = true;
  }
}
