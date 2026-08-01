import {
  AfterViewInit,
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  ElementRef,
  EventEmitter,
  HostBinding,
  HostListener,
  Input,
  type OnChanges,
  type OnDestroy,
  Output,
  ViewChild,
} from '@angular/core';
import * as d3 from 'd3';
import type {MwsNode} from '../../domain/mws/mws.types';
import {findNodeById, hasUpdate} from '../../domain/mws/map-builder';
import type {PositionsLoadOutcome} from '../../services/node-position.store';
import {
  DEFAULT_LAYOUT_CONFIG,
  type GraphLayout,
  type PositionedEdge,
  type PositionedNode,
  layoutForest,
  topologySignature,
} from './graph-layout';
import {edgeTooltip, edgeType, linkQuality} from './link-quality';

export const FIT_PADDING = 40;
export const CLICK_SLOP = 4;

interface Position {
  x: number;
  y: number;
}

interface DragState {
  id: string;
  origin: Position;
  pointerOrigin: Position;
  screenOrigin: Position;
  moved: boolean;
}

@Component({
  selector: 'mws-map-graph',
  standalone: true,
  template: `
    <div class="graph-controls" aria-label="Map view controls">
      <div class="graph-view-controls" aria-label="View controls">
        <mndw-button variant="secondary" aria-label="Zoom in" (click)="zoomIn()">+</mndw-button>
        <mndw-button variant="secondary" aria-label="Zoom out" (click)="zoomOut()">−</mndw-button>
        <mndw-button variant="secondary" aria-label="Fit to content" (click)="recenter()">⌖</mndw-button>
      </div>
      <div class="graph-edit-controls" aria-label="Layout controls">
        @if (editMode) {
          <mndw-button variant="primary" class="graph-action" aria-label="Auto layout" (click)="requestAutoLayout()">Auto layout</mndw-button>
          <mndw-button variant="primary" class="graph-action" aria-label="Done" (click)="requestDoneEditing()">Done</mndw-button>
        }
        <mndw-button
          variant="secondary"
          type="button"
          class="graph-action"
          aria-label="Rearrange"
          [attr.aria-pressed]="editMode"
          [disabled]="editMode"
          (click)="toggleEditMode()"
        >Rearrange</mndw-button>
      </div>
    </div>
    <svg #svg class="mws-graph" role="group" aria-label="MWS topology" tabindex="0"></svg>
  `,
  styleUrls: ['./mws-graph.component.scss'],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class MwsGraphComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({required: true})
  public roots: MwsNode[] = [];

  @Input()
  public nodePositions: ReadonlyMap<string, Position> = new Map();

  @Input()
  public positionsLoadOutcome: PositionsLoadOutcome = 'pending';

  @Input()
  public editMode = false;

  @Input()
  public selectedNodeId: string | null = null;

  @Output()
  public readonly nodeSelected = new EventEmitter<string>();

  @Output()
  public readonly nodePositionChanged = new EventEmitter<Position & {id: string}>();

  @Output()
  public readonly editModeToggled = new EventEmitter<void>();

  @Output()
  public readonly autoLayoutRequested = new EventEmitter<void>();

  @Output()
  public readonly doneEditingRequested = new EventEmitter<void>();

  @HostBinding('class.editing')
  public get editingClass(): boolean {
    return this.editMode;
  }

  @ViewChild('svg', {static: true})
  private svgRef?: ElementRef<SVGSVGElement>;

  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private zoomGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  private zoom: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastTopologySignature: string | null = null;
  private layout: GraphLayout | null = null;
  private previousPositionsLoadOutcome: PositionsLoadOutcome = 'pending';
  private initialPositionFit = false;
  private pendingFit = false;
  private forceFit = false;
  private userAdjusted = false;
  private dragState: DragState | null = null;
  private readonly dragPositions = new Map<string, Position>();
  private skippedChangeDuringDrag = false;

  public ngAfterViewInit(): void {
    const svgElement = this.svgRef?.nativeElement;

    if (svgElement === undefined) {
      return;
    }

    this.svg = d3.select(svgElement);
    this.zoomGroup = this.svg.append('g');
    this.zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 10])
      .on('start', (event) => {
        if (event.sourceEvent !== null && event.sourceEvent !== undefined) {
          svgElement.focus({preventScroll: true});
          this.userAdjusted = true;
        }
      })
      .on('zoom', (event) => {
        this.zoomGroup?.attr('transform', event.transform.toString());
      });

    this.svg.call(this.zoom);
    this.observeResize(svgElement);
    this.render();
  }

  public ngOnChanges(): void {
    if (this.dragState !== null) {
      this.skippedChangeDuringDrag = true;

      return;
    }

    this.reconcileDragPositions();
    this.render();
  }

  public ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.svg?.on('.zoom', null);
  }

  public resetView(): void {
    this.userAdjusted = false;
    this.forceFit = true;

    if (this.nodePositions.size === 0) {
      this.render();
    }
  }

  @HostListener('keydown', ['$event'])
  public onHostKeydown(event: KeyboardEvent): void {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      this.zoomIn();
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      this.zoomOut();
    } else if (event.key === '0') {
      event.preventDefault();
      this.userAdjusted = false;
      this.fitToContent(true);
    }
  }

  public zoomIn(): void {
    this.userAdjusted = true;
    this.zoomBy(1.4);
  }

  public zoomOut(): void {
    this.userAdjusted = true;
    this.zoomBy(1 / 1.4);
  }

  public toggleEditMode(): void {
    this.editModeToggled.emit();
  }

  public requestAutoLayout(): void {
    this.autoLayoutRequested.emit();
  }

  public requestDoneEditing(): void {
    this.doneEditingRequested.emit();
  }

  public recenter(): void {
    this.userAdjusted = false;
    this.fitToContent(true);
  }

  private observeResize(svgElement: SVGSVGElement): void {
    const host = svgElement.parentElement ?? svgElement;

    this.resizeObserver = new ResizeObserver(() => {
      const {width, height} = this.geometry(host, svgElement);

      this.svg?.attr('width', width).attr('height', height);

      if (this.pendingFit && width > 0 && height > 0) {
        this.pendingFit = false;
        this.fitToContent(false);
      }
    });
    this.resizeObserver.observe(host);

    const {width, height} = this.geometry(host, svgElement);

    this.svg?.attr('width', width).attr('height', height);
  }

  private zoomBy(factor: number): void {
    if (this.svg === null || this.zoom === null) {
      return;
    }

    const zoom = this.zoom;

    this.svg.call((selection) => zoom.scaleBy(selection, factor));
  }

  private render(): void {
    const group = this.zoomGroup;

    if (group === null) {
      return;
    }

    const signature = topologySignature(this.roots);
    const topologyChanged = signature !== this.lastTopologySignature;

    if (topologyChanged || this.layout === null) {
      this.layout = layoutForest(this.roots);
      this.lastTopologySignature = signature;
    } else {
      this.repointLayout(this.layout);
    }

    const layout = this.layout;

    this.renderEdges(group, layout.edges);
    this.renderNodes(group, layout.nodes);

    const positionLoadFinished = !this.initialPositionFit
      && this.previousPositionsLoadOutcome === 'pending'
      && this.positionsLoadOutcome !== 'pending';

    this.previousPositionsLoadOutcome = this.positionsLoadOutcome;

    if (positionLoadFinished) {
      this.initialPositionFit = true;
    }

    const shouldFit = this.forceFit
      || (topologyChanged && !this.userAdjusted)
      || (positionLoadFinished && this.positionsLoadOutcome === 'applied' && !this.userAdjusted);

    if (shouldFit) {
      this.fitToContent(false);

      if (!this.pendingFit) {
        this.forceFit = false;
      }
    }
  }

  private repointLayout(layout: GraphLayout): void {
    const current = new Map<string, MwsNode>();
    const visit = (node: MwsNode): void => {
      current.set(node.id, node);

      for (const child of node.children) {
        visit(child.node);
      }
    };

    for (const root of this.roots) {
      visit(root);
    }

    const nodes = layout.nodes.filter((positioned) => current.has(positioned.node.id));
    const byId = new Map(nodes.map((positioned) => [positioned.node.id, positioned]));

    for (const positioned of nodes) {
      const node = current.get(positioned.node.id);

      if (node !== undefined) {
        positioned.node = node;
      }
    }

    layout.nodes = nodes;
    layout.edges = layout.edges
      .map((edge) => ({
        source: byId.get(edge.source.node.id),
        target: byId.get(edge.target.node.id),
      }))
      .filter((edge): edge is PositionedEdge => edge.source !== undefined && edge.target !== undefined);
  }

  private effectivePosition(positioned: PositionedNode): Position {
    const dragged = this.dragPositions.get(positioned.node.id);

    if (dragged !== undefined) {
      return dragged;
    }

    const manual = this.nodePositions.get(positioned.node.id);

    return manual === undefined ? {x: positioned.x, y: positioned.y} : manual;
  }

  private edgePath(edge: PositionedEdge): string {
    const half = DEFAULT_LAYOUT_CONFIG.nodeHeight / 2;
    const source = this.effectivePosition(edge.source);
    const target = this.effectivePosition(edge.target);
    const x1 = source.x;
    const y1 = source.y + half;
    const x2 = target.x;
    const y2 = target.y - half;
    const midY = (y1 + y2) / 2;

    return `M ${x1} ${y1} C ${x1} ${midY} ${x2} ${midY} ${x2} ${y2}`;
  }

  private renderEdges(
    group: d3.Selection<SVGGElement, unknown, null, undefined>,
    edges: PositionedEdge[],
  ): void {
    const selected = this.selectionState();

    group.selectAll<SVGPathElement, PositionedEdge>('path.edge')
      .data(edges, (edge) => `${edge.source.node.id}->${edge.target.node.id}`)
      .join((enter) => {
        const path = enter.append('path');

        path.append('title');

        return path;
      })
      .attr('class', (edge) => {
        const pathClass = this.pathSelectionClass(edge, selected);

        return ['edge', edgeType(edge.target.node), linkQuality(edge.target.node), pathClass]
          .filter((value) => value !== '')
          .join(' ');
      })
      .attr('d', (edge) => this.edgePath(edge))
      .select('title')
      .text((edge) => edgeTooltip(edge.target.node));
  }

  private renderNodes(
    group: d3.Selection<SVGGElement, unknown, null, undefined>,
    nodes: PositionedNode[],
  ): void {
    const {nodeWidth, nodeHeight} = DEFAULT_LAYOUT_CONFIG;
    const selected = this.selectionState();
    const nodeGroups = group.selectAll<SVGGElement, PositionedNode>('g.node')
      .data(nodes, (positioned) => positioned.node.id)
      .join((enter) => {
        const nodeGroup = enter.append('g');

        nodeGroup.append('rect');
        nodeGroup.append('text').attr('class', 'name');
        nodeGroup.append('text').attr('class', 'model');
        nodeGroup.append('text').attr('class', 'client-count');
        nodeGroup.append('g').attr('class', 'client-badge')
          .call((badge) => {
            badge.append('circle');
            badge.append('text');
          });
        nodeGroup.append('circle').attr('class', 'update-dot');

        return nodeGroup;
      })
      .attr('class', (positioned) => this.nodeClass(positioned.node, selected))
      .attr('transform', (positioned) => {
        const position = this.effectivePosition(positioned);

        return `translate(${position.x},${position.y})`;
      })
      .attr('role', 'button')
      .attr('tabindex', 0)
      .attr('aria-label', (positioned) => this.nodeLabel(positioned.node))
      .on('keydown', (event: KeyboardEvent, positioned) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.nodeSelected.emit(positioned.node.id);
        }
      });

    if (this.editMode) {
      nodeGroups.on('click', null);
    } else {
      nodeGroups.on('click', (_event: MouseEvent, positioned: PositionedNode) => {
        this.nodeSelected.emit(positioned.node.id);
      });
    }

    nodeGroups.select('rect')
      .attr('x', -nodeWidth / 2)
      .attr('y', -nodeHeight / 2)
      .attr('width', nodeWidth)
      .attr('height', nodeHeight)
      .attr('rx', 6);

    nodeGroups.select('text.name')
      .attr('text-anchor', 'middle')
      .attr('y', -15)
      .text((positioned) => positioned.node.name);

    nodeGroups.select('text.model')
      .attr('text-anchor', 'middle')
      .attr('y', 2)
      .text((positioned) => positioned.node.model ?? '');

    nodeGroups.select('text.client-count')
      .attr('text-anchor', 'middle')
      .attr('y', 18)
      .text((positioned) => positioned.node.clients.length > 0 ? `${positioned.node.clients.length} clients` : '');

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
      .style('display', (positioned) => hasUpdate(positioned.node) ? null : 'none');

    this.applyDragBehavior(nodeGroups);
  }

  private applyDragBehavior(nodeGroups: d3.Selection<SVGGElement, PositionedNode, SVGGElement, unknown>): void {
    if (!this.editMode || this.zoomGroup === null) {
      nodeGroups.on('.drag', null);

      return;
    }

    const drag = d3.drag<SVGGElement, PositionedNode>()
      .on('start', (event, positioned) => this.onDragStart(event, positioned))
      .on('drag', (event, positioned) => this.onDrag(event, positioned))
      .on('end', (event, positioned) => this.onDragEnd(event, positioned));

    nodeGroups.call(drag);
  }

  private onDragStart(event: d3.D3DragEvent<SVGGElement, PositionedNode, unknown>, positioned: PositionedNode): void {
    event.sourceEvent.stopPropagation();

    const group = this.zoomGroup;

    if (group === null) {
      return;
    }

    const source = this.screenPoint(event.sourceEvent);
    const position = this.effectivePosition(positioned);
    const pointer = d3.pointer(event.sourceEvent, group.node());

    this.dragState = {
      id: positioned.node.id,
      origin: {...position},
      pointerOrigin: {x: pointer[0], y: pointer[1]},
      screenOrigin: source,
      moved: false,
    };
  }

  private onDrag(event: d3.D3DragEvent<SVGGElement, PositionedNode, unknown>, positioned: PositionedNode): void {
    const state = this.dragState;
    const group = this.zoomGroup;

    if (state === null || group === null || state.id !== positioned.node.id) {
      return;
    }

    const pointer = d3.pointer(event.sourceEvent, group.node());
    const next = {
      x: state.origin.x + pointer[0] - state.pointerOrigin.x,
      y: state.origin.y + pointer[1] - state.pointerOrigin.y,
    };
    const source = this.screenPoint(event.sourceEvent);
    const dx = source.x - state.screenOrigin.x;
    const dy = source.y - state.screenOrigin.y;

    state.moved = state.moved || Math.sqrt(dx * dx + dy * dy) >= CLICK_SLOP;
    this.dragPositions.set(state.id, next);
    this.updateDraggedNode(positioned.node.id, next);
    this.updateIncidentEdges(positioned.node.id);
  }

  private onDragEnd(event: d3.D3DragEvent<SVGGElement, PositionedNode, unknown>, positioned: PositionedNode): void {
    const state = this.dragState;

    if (state?.id !== positioned.node.id) {
      return;
    }

    const source = this.screenPoint(event.sourceEvent);
    const dx = source.x - state.screenOrigin.x;
    const dy = source.y - state.screenOrigin.y;
    const isClick = Math.sqrt(dx * dx + dy * dy) < CLICK_SLOP;
    const next = this.dragPositions.get(state.id);

    this.dragState = null;

    if (isClick || next === undefined) {
      this.dragPositions.delete(state.id);
      this.nodeSelected.emit(state.id);
    } else {
      this.nodePositionChanged.emit({id: state.id, ...next});
    }

    if (this.skippedChangeDuringDrag) {
      this.skippedChangeDuringDrag = false;
      this.reconcileDragPositions();
      this.render();
    }
  }

  private updateDraggedNode(id: string, position: Position): void {
    this.zoomGroup?.selectAll<SVGGElement, PositionedNode>('g.node')
      .filter((node) => node.node.id === id)
      .attr('transform', `translate(${position.x},${position.y})`);
  }

  private screenPoint(sourceEvent: Event): Position {
    const mouseEvent = sourceEvent as MouseEvent;

    if (typeof mouseEvent.clientX === 'number') {
      return {x: mouseEvent.clientX, y: mouseEvent.clientY};
    }

    const touchEvent = sourceEvent as TouchEvent;
    const touch = touchEvent.changedTouches[0] ?? touchEvent.touches[0];

    return {x: touch?.clientX ?? 0, y: touch?.clientY ?? 0};
  }

  private updateIncidentEdges(id: string): void {
    if (this.layout === null || this.zoomGroup === null) {
      return;
    }

    this.zoomGroup.selectAll<SVGPathElement, PositionedEdge>('path.edge')
      .filter((edge) => edge.source.node.id === id || edge.target.node.id === id)
      .attr('d', (edge) => this.edgePath(edge));
  }

  private reconcileDragPositions(): void {
    for (const [id, position] of this.dragPositions) {
      const input = this.nodePositions.get(id);

      if (input?.x === position.x && input?.y === position.y) {
        this.dragPositions.delete(id);
      }
    }
  }

  private selectionState(): {selected: MwsNode | null; path: Set<string>} {
    if (this.selectedNodeId === null) {
      return {selected: null, path: new Set()};
    }

    const selected = findNodeById(this.roots, this.selectedNodeId);

    if (selected === null) {
      return {selected: null, path: new Set()};
    }

    const path = new Set<string>();
    let current: MwsNode | null = selected;

    while (current !== null) {
      path.add(current.id);
      current = current.parent?.node ?? null;
    }

    return {selected, path};
  }

  private nodeClass(node: MwsNode, selection: {selected: MwsNode | null; path: Set<string>}): string {
    const stateClass = [
      node.isController ? 'controller' : '',
      node.isOnline ? '' : 'offline',
      selection.selected === null ? '' : node.id === selection.selected.id
        ? 'selected'
        : selection.path.has(node.id)
        ? 'on-path'
        : 'dimmed',
    ].filter((value) => value !== '');

    return ['node', ...stateClass].join(' ');
  }

  private pathSelectionClass(
    edge: PositionedEdge,
    selection: {selected: MwsNode | null; path: Set<string>},
  ): string {
    if (selection.selected === null) {
      return '';
    }

    return selection.path.has(edge.source.node.id) && selection.path.has(edge.target.node.id) ? 'on-path' : 'dimmed';
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

  private fitToContent(animate: boolean): void {
    if (this.svg === null || this.zoom === null || this.layout === null || this.layout.nodes.length === 0) {
      return;
    }

    const viewport = this.viewport();

    if (viewport.width <= 0 || viewport.height <= 0) {
      this.pendingFit = true;

      return;
    }

    const {nodeWidth, nodeHeight} = DEFAULT_LAYOUT_CONFIG;
    const positions = this.layout.nodes.map((positioned) => this.effectivePosition(positioned));
    const minX = Math.min(...positions.map((position) => position.x)) - nodeWidth / 2 - FIT_PADDING;
    const maxX = Math.max(...positions.map((position) => position.x)) + nodeWidth / 2 + FIT_PADDING;
    const minY = Math.min(...positions.map((position) => position.y)) - nodeHeight / 2 - FIT_PADDING;
    const maxY = Math.max(...positions.map((position) => position.y)) + nodeHeight / 2 + FIT_PADDING;
    const boxWidth = maxX - minX;
    const boxHeight = maxY - minY;
    const scale = Math.min(1, Math.max(0.1, Math.min(viewport.width / boxWidth, viewport.height / boxHeight)));
    const transform = d3.zoomIdentity
      .translate(viewport.width / 2 - scale * ((minX + maxX) / 2), viewport.height / 2 - scale * ((minY + maxY) / 2))
      .scale(scale);

    this.pendingFit = false;

    const zoom = this.zoom;

    if (animate) {
      this.svg.transition().duration(200)
        .call((selection) => zoom.transform(selection, transform));
    } else {
      this.svg.call((selection) => zoom.transform(selection, transform));
    }
  }

  private viewport(): {width: number; height: number} {
    const svgElement = this.svgRef?.nativeElement;
    const host = svgElement?.parentElement ?? svgElement;

    return this.geometry(host ?? null, svgElement);
  }

  private geometry(host: Element | null, svgElement: SVGSVGElement | undefined): {width: number; height: number} {
    return {
      width: host?.clientWidth || svgElement?.clientWidth || 0,
      height: host?.clientHeight || svgElement?.clientHeight || 0,
    };
  }
}
