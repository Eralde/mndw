import {
  AfterViewInit,
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  type OnDestroy,
  ViewChild,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import * as d3 from 'd3';
import type {MwsNode} from '../../domain/mws/mws.types';
import {findNodeById, hasUpdate} from '../../domain/mws/map-builder';
import type {PositionsLoadOutcome} from '../../services/node-position.store';
import type {ExtraFeaturesAvailability} from '../../services/mwsd-status.service';
import {
  DEFAULT_LAYOUT_CONFIG,
  type GraphLayout,
  type PositionedEdge,
  type PositionedNode,
  layoutForest,
  topologySignature,
} from './graph-layout';
import {edgeTooltip, edgeType, linkQuality} from './link-quality';
import {TRANSLATOR} from '../../tokens';
import {getNodeStatusLabels} from '../../status-labels';
import {type MndwIconName, mndwIconHref, subscribeMndwIconSprite} from '@mndw/ui';
import {dragPosition, isClickWithinSlop} from './graph-interaction';
import {type GraphSelectionState, edgePath, effectivePosition, nodeClass, pathSelectionClass} from './graph-rendering';

export const FIT_PADDING = 40;
export const CLICK_SLOP = 4;
const MAX_TEXT_FIT_RETRIES = 2;
const NAME_AVERAGE_GLYPH_WIDTH = 8.5;
const DETAIL_AVERAGE_GLYPH_WIDTH = 7.5;

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

interface NodeIcon {
  name: MndwIconName;
  label: string;
  color: string;
}

function truncateTextByEstimatedWidth(value: string, maxWidth: number, averageGlyphWidth: number): string {
  const maxCharacters = Math.floor(maxWidth / averageGlyphWidth);

  if (value.length <= maxCharacters) {
    return value;
  }

  if (maxCharacters < 1) {
    return '';
  }

  return `${value.slice(0, maxCharacters - 1)}…`;
}

function truncateSvgText(
  element: SVGTextElement,
  value: string,
  maxWidth: number,
  averageGlyphWidth: number,
): {text: string; pending: boolean} {
  const fallback = (): {text: string; pending: boolean} => ({
    text: truncateTextByEstimatedWidth(value, maxWidth, averageGlyphWidth),
    pending: true,
  });

  if (value === '') {
    return {text: '', pending: false};
  }

  if (typeof element.getComputedTextLength !== 'function') {
    return fallback();
  }

  const widthOf = (text: string): number | null => {
    element.textContent = text;

    try {
      const width = element.getComputedTextLength();

      return Number.isFinite(width) && (width > 0 || text === '') ? width : null;
    } catch {
      return null;
    }
  };

  const fullWidth = widthOf(value);

  if (fullWidth === null) {
    return fallback();
  }

  if (fullWidth <= maxWidth) {
    return {text: value, pending: false};
  }

  let low = 0;
  let high = value.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidateWidth = widthOf(`${value.slice(0, middle)}…`);

    if (candidateWidth === null) {
      return fallback();
    }

    if (candidateWidth <= maxWidth) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  const result = `${value.slice(0, low)}…`;

  return widthOf(result) === null ? fallback() : {text: result, pending: false};
}

@Component({
  selector: 'mws-map-graph',
  standalone: true,
  template: `
    <span data-testid="l10n-child-probe" hidden>{{ t('l10n.probe') }}</span>
    <div class="graph-view-controls" [attr.aria-label]="t('graph.view-controls')">
      <mndw-button variant="secondary" [attr.aria-label]="t('action.zoom-in')" (click)="zoomIn()">+</mndw-button>
      <mndw-button variant="secondary" [attr.aria-label]="t('action.zoom-out')" (click)="zoomOut()">−</mndw-button>
      <mndw-button variant="secondary" [attr.aria-label]="t('action.fit')" (click)="recenter()">⌖</mndw-button>
    </div>
    <div class="graph-edit-controls" [attr.aria-label]="t('graph.layout-controls')">
      @if (editMode()) {
        <mndw-button variant="primary" class="graph-action" [attr.aria-label]="t('action.auto-layout')" (click)="requestAutoLayout()">{{ t('action.auto-layout') }}</mndw-button>
        <mndw-button variant="primary" class="graph-action" [attr.aria-label]="t('action.done')" (click)="requestDoneEditing()">{{ t('action.done') }}</mndw-button>
      }
      <mndw-button
        variant="secondary"
        type="button"
        class="graph-action rearrange-button"
        [attr.aria-label]="t('action.rearrange')"
        [attr.aria-pressed]="editMode()"
        [disabled]="editMode()"
        (click)="toggleEditMode()"
      ><mndw-icon name="pencil"></mndw-icon>{{ t('action.rearrange') }}</mndw-button>
    </div>
    <svg #svg class="mws-graph" role="group" [attr.aria-label]="t('graph.topology')" tabindex="0"></svg>
  `,
  styleUrls: ['./mws-graph.component.scss'],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class MwsGraphComponent implements AfterViewInit, OnDestroy {
  private readonly translator = inject(TRANSLATOR);
  public readonly roots = input.required<MwsNode[]>();

  public readonly nodePositions = input<ReadonlyMap<string, Position>>(new Map());

  public readonly positionsLoadOutcome = input<PositionsLoadOutcome>('pending');

  public readonly extraFeaturesAvailability = input<ExtraFeaturesAvailability>('checking');

  public readonly editMode = input(false);

  public readonly selectedNodeId = input<string | null>(null);

  public readonly nodeSelected = output<string>();

  public readonly nodePositionChanged = output<Position & {id: string}>();

  public readonly editModeToggled = output<void>();

  public readonly autoLayoutRequested = output<void>();

  public readonly doneEditingRequested = output<void>();

  @HostBinding('class.editing')
  public get editingClass(): boolean {
    return this.editMode();
  }

  @ViewChild('svg', {static: true})
  private svgRef?: ElementRef<SVGSVGElement>;

  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private zoomGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  private zoom: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribeIconSprite: (() => void) | null = null;
  private pendingNodeTextFit = false;
  private textFitFrame: number | null = null;
  private textFitRetryCount = 0;
  private destroyed = false;
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
  private pointerNodeId: string | null = null;
  private focusNodeId: string | null = null;
  private activeSource: 'pointer' | 'focus' | null = null;

  private readonly inputEffect = effect(() => {
    this.roots();
    this.nodePositions();
    this.positionsLoadOutcome();
    this.extraFeaturesAvailability();
    void this.translator.locale;

    const editMode = this.editMode();

    this.selectedNodeId();

    if (editMode) {
      this.clearHoverState();
    }

    if (this.dragState !== null) {
      this.skippedChangeDuringDrag = true;

      return;
    }

    this.reconcileDragPositions();
    this.render();
  });

  public ngAfterViewInit(): void {
    const svgElement = this.svgRef?.nativeElement;

    if (svgElement === undefined) {
      return;
    }

    this.svg = d3.select(svgElement);
    this.zoomGroup = this.svg.append('g');
    this.unsubscribeIconSprite = subscribeMndwIconSprite(() => this.refreshNodeIconHrefs());
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
        this.zoomGroup?.classed('zoom-hide-indicators', event.transform.k < 0.4);
      });

    this.svg.call(this.zoom);
    this.observeResize(svgElement);
    this.render();

    const fontsReady = document.fonts?.ready;

    if (fontsReady !== undefined) {
      void fontsReady.then(() => this.refitPendingNodeText());
    }
  }

  public ngOnDestroy(): void {
    this.destroyed = true;
    this.cancelTextFitRetry();
    this.unsubscribeIconSprite?.();
    this.unsubscribeIconSprite = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.svg?.on('.zoom', null);
  }

  public resetView(): void {
    this.userAdjusted = false;
    this.forceFit = true;

    if (this.nodePositions().size === 0) {
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

      if (this.pendingNodeTextFit && width > 0 && height > 0) {
        this.fitNodeText();
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

    const signature = topologySignature(this.roots());
    const topologyChanged = signature !== this.lastTopologySignature;

    if (topologyChanged || this.layout === null) {
      this.layout = layoutForest(this.roots());
      this.lastTopologySignature = signature;
    } else {
      this.repointLayout(this.layout);
    }

    const layout = this.layout;

    this.renderEdges(group, layout.edges);
    this.renderNodes(group, layout.nodes);

    const positionLoadFinished = !this.initialPositionFit
      && this.previousPositionsLoadOutcome === 'pending'
      && this.positionsLoadOutcome() !== 'pending';

    this.previousPositionsLoadOutcome = this.positionsLoadOutcome();

    if (positionLoadFinished) {
      this.initialPositionFit = true;
    }

    const shouldFit = this.forceFit
      || (topologyChanged && !this.userAdjusted)
      || (positionLoadFinished && this.positionsLoadOutcome() === 'applied' && !this.userAdjusted);

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

    for (const root of this.roots()) {
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
        const pathClass = pathSelectionClass(edge, selected);

        return ['edge', edgeType(edge.target.node), linkQuality(edge.target.node), pathClass]
          .filter((value) => value !== '')
          .join(' ');
      })
      .attr('d', (edge) =>
        edgePath({
          source: effectivePosition(edge.source, this.nodePositions(), this.dragPositions),
          target: effectivePosition(edge.target, this.nodePositions(), this.dragPositions),
        }))
      .select('title')
      .text((edge) => edgeTooltip(edge.target.node, (key) => this.t(key)));

    group.selectAll('g.edge-indicator').remove();
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

        nodeGroup.append('title').attr('class', 'node-name-title');
        nodeGroup.append('rect').attr('class', 'selection-ring');
        nodeGroup.append('rect').attr('class', 'node-body');
        nodeGroup.append('rect').attr('class', 'focus-ring');
        nodeGroup.append('text').attr('class', 'controller-badge');
        nodeGroup.append('text').attr('class', 'name');
        nodeGroup.append('text').attr('class', 'model');
        nodeGroup.append('text').attr('class', 'client-count status-line');
        nodeGroup.append('g').attr('class', 'node-icons');

        return nodeGroup;
      })
      .attr('class', (positioned) => nodeClass(positioned.node, selected))
      .attr('data-node-id', (positioned) => positioned.node.id)
      .attr('transform', (positioned) => {
        const position = effectivePosition(positioned, this.nodePositions(), this.dragPositions);

        return `translate(${position.x},${position.y})`;
      })
      .attr('role', 'button')
      .attr('tabindex', 0)
      .attr('aria-label', (positioned) => this.nodeLabel(positioned.node))
      .on('pointerenter', (_event: PointerEvent, positioned: PositionedNode) => {
        this.onPointerEnter(positioned.node.id);
      })
      .on('pointerleave', (_event: PointerEvent, positioned: PositionedNode) => {
        this.onPointerLeave(positioned.node.id);
      })
      .on('focusin', (_event: FocusEvent, positioned: PositionedNode) => {
        this.onFocusIn(positioned.node.id);
      })
      .on('focusout', (_event: FocusEvent, positioned: PositionedNode) => {
        this.onFocusOut(positioned.node.id);
      })
      .on('keydown', (event: KeyboardEvent, positioned) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.selectNode(positioned.node.id);
        }
      });

    if (this.editMode()) {
      nodeGroups.on('click', null);
    } else {
      nodeGroups.on('click', (_event: MouseEvent, positioned: PositionedNode) => {
        this.selectNode(positioned.node.id);
      });
    }

    nodeGroups.select('rect.selection-ring')
      .attr('x', -(nodeWidth / 2 + 5))
      .attr('y', -(nodeHeight / 2 + 5))
      .attr('width', nodeWidth + 10)
      .attr('height', nodeHeight + 10)
      .attr('rx', 11)
      .style('display', (positioned) => positioned.node.id === selected.selected?.id ? null : 'none');

    nodeGroups.select('rect.node-body')
      .attr('x', -nodeWidth / 2)
      .attr('y', -nodeHeight / 2)
      .attr('width', nodeWidth)
      .attr('height', nodeHeight)
      .attr('rx', 6);

    nodeGroups.select('rect.focus-ring')
      .attr('x', -(nodeWidth / 2 + 5))
      .attr('y', -(nodeHeight / 2 + 5))
      .attr('width', nodeWidth + 10)
      .attr('height', nodeHeight + 10)
      .attr('rx', 11);

    nodeGroups.select('title.node-name-title')
      .text((positioned) => positioned.node.name);

    nodeGroups.select('text.controller-badge')
      .attr('text-anchor', 'middle')
      .attr('y', -(nodeHeight / 2) - 6)
      .text((positioned) => positioned.node.isController ? `(${this.t('graph.controller')})` : '');

    const textStart = -nodeWidth / 2 + 12;
    const textSelection = nodeGroups.selectAll<SVGTextElement, PositionedNode>(
      'text.name, text.model, text.status-line',
    );

    textSelection
      .attr('text-anchor', 'start')
      .attr('x', textStart);

    nodeGroups.select<SVGTextElement>('text.name').attr('y', -11);
    nodeGroups.select<SVGTextElement>('text.model').attr('y', 5);
    nodeGroups.select<SVGTextElement>('text.status-line').attr('y', 20);

    const icons = nodeGroups.select('g.node-icons')
      .selectAll<SVGSVGElement, NodeIcon>('svg.node-icon')
      .data((positioned) => this.nodeIcons(positioned.node))
      .join((enter) => {
        const icon = enter.append('svg');

        icon.append('title');
        icon.append('use');

        return icon;
      })
      .attr('class', 'node-icon')
      .attr('viewBox', '0 0 24 24')
      .attr('x', nodeWidth / 2 - 12 - 14)
      .attr('y', (_icon, index) => -nodeHeight / 2 + 10 + index * 16)
      .attr('width', 14)
      .attr('height', 14)
      .attr('focusable', 'false')
      .attr('aria-hidden', 'true')
      .attr('data-icon', (icon) => icon.name)
      .style('color', (icon) => icon.color)
      .style('stroke', 'currentColor');

    icons.select('title').text((icon) => icon.label);
    icons.select('use')
      .attr('width', 24)
      .attr('height', 24)
      .attr('href', (icon) => {
        const href = mndwIconHref(icon.name);

        return href === '' ? null : href;
      });

    this.fitNodeText();
    this.applyDragBehavior(nodeGroups);
  }

  private fitNodeText(): void {
    const group = this.zoomGroup;

    if (group === null) {
      return;
    }

    const {nodeWidth} = DEFAULT_LAYOUT_CONFIG;
    let pending = false;

    group.selectAll<SVGGElement, PositionedNode>('g.node')
      .each((positioned, index, elements) => {
        const node = elements[index];

        if (node === undefined) {
          return;
        }

        const hasIcons = this.nodeIcons(positioned.node).length > 0;
        const maxWidth = nodeWidth - 24 - (hasIcons ? 14 + 8 : 0);
        const name = node.querySelector<SVGTextElement>('text.name');
        const model = node.querySelector<SVGTextElement>('text.model');
        const status = node.querySelector<SVGTextElement>('text.status-line');

        if (name !== null) {
          const fit = truncateSvgText(name, positioned.node.name, maxWidth, NAME_AVERAGE_GLYPH_WIDTH);

          name.textContent = fit.text;
          pending ||= fit.pending;
        }

        if (model !== null) {
          const fit = truncateSvgText(model, positioned.node.model ?? '', maxWidth, DETAIL_AVERAGE_GLYPH_WIDTH);

          model.textContent = fit.text;
          pending ||= fit.pending;
        }

        if (status !== null) {
          const value = positioned.node.isOnline
            ? positioned.node.clients.length > 0
              ? this.t('status.clients', {count: positioned.node.clients.length})
              : ''
            : this.t('graph.offline');
          const fit = truncateSvgText(status, value, maxWidth, DETAIL_AVERAGE_GLYPH_WIDTH);

          status.textContent = fit.text;
          pending ||= fit.pending;
        }
      });

    this.pendingNodeTextFit = pending;

    if (pending) {
      this.scheduleTextFitRetry();
    } else {
      this.cancelTextFitRetry();
      this.textFitRetryCount = 0;
    }
  }

  private refitPendingNodeText(): void {
    if (!this.pendingNodeTextFit || this.destroyed) {
      return;
    }

    this.fitNodeText();
  }

  private scheduleTextFitRetry(): void {
    if (
      this.destroyed
      || !this.pendingNodeTextFit
      || this.textFitFrame !== null
      || this.textFitRetryCount >= MAX_TEXT_FIT_RETRIES
      || typeof requestAnimationFrame !== 'function'
    ) {
      return;
    }

    this.textFitFrame = requestAnimationFrame(() => {
      this.textFitFrame = null;

      if (!this.pendingNodeTextFit || this.destroyed) {
        return;
      }

      this.textFitRetryCount += 1;
      this.fitNodeText();
    });
  }

  private cancelTextFitRetry(): void {
    if (this.textFitFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.textFitFrame);
    }

    this.textFitFrame = null;
  }

  private applyDragBehavior(nodeGroups: d3.Selection<SVGGElement, PositionedNode, SVGGElement, unknown>): void {
    if (!this.editMode() || this.zoomGroup === null) {
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
    const position = effectivePosition(positioned, this.nodePositions(), this.dragPositions);
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
    const next = dragPosition(state.origin, {x: pointer[0], y: pointer[1]}, state.pointerOrigin);
    const source = this.screenPoint(event.sourceEvent);

    state.moved = state.moved || !isClickWithinSlop(state.screenOrigin, source, CLICK_SLOP);
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
    const isClick = isClickWithinSlop(state.screenOrigin, source, CLICK_SLOP);
    const next = this.dragPositions.get(state.id);

    this.dragState = null;

    if (isClick || next === undefined) {
      this.dragPositions.delete(state.id);
      this.selectNode(state.id);
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
      .attr('d', (edge) =>
        edgePath({
          source: effectivePosition(edge.source, this.nodePositions(), this.dragPositions),
          target: effectivePosition(edge.target, this.nodePositions(), this.dragPositions),
        }));
  }

  private reconcileDragPositions(): void {
    for (const [id, position] of this.dragPositions) {
      const manualPosition = this.nodePositions().get(id);

      if (manualPosition?.x === position.x && manualPosition?.y === position.y) {
        this.dragPositions.delete(id);
      }
    }
  }

  private selectNode(id: string): void {
    this.clearHoverState();
    this.nodeSelected.emit(id);
  }

  private onPointerEnter(id: string): void {
    if (this.editMode()) {
      return;
    }

    this.pointerNodeId = id;
    this.activeSource = 'pointer';
    this.applySelectionVisuals();
  }

  private onPointerLeave(id: string): void {
    if (this.editMode() || this.pointerNodeId !== id) {
      return;
    }

    this.pointerNodeId = null;

    if (this.activeSource === 'pointer') {
      this.activeSource = this.focusNodeId === null ? null : 'focus';
    }

    this.applySelectionVisuals();
  }

  private onFocusIn(id: string): void {
    if (this.editMode()) {
      return;
    }

    this.focusNodeId = id;
    this.activeSource = 'focus';
    this.applySelectionVisuals();
  }

  private onFocusOut(id: string): void {
    if (this.editMode() || this.focusNodeId !== id) {
      return;
    }

    this.focusNodeId = null;

    if (this.activeSource === 'focus') {
      this.activeSource = this.pointerNodeId === null ? null : 'pointer';
    }

    this.applySelectionVisuals();
  }

  private clearHoverState(): void {
    this.pointerNodeId = null;
    this.focusNodeId = null;
    this.activeSource = null;
  }

  private applySelectionVisuals(): void {
    const group = this.zoomGroup;

    if (group === null) {
      return;
    }

    const selection = this.selectionState();
    const {nodeWidth, nodeHeight} = DEFAULT_LAYOUT_CONFIG;

    group.selectAll<SVGGElement, PositionedNode>('g.node')
      .attr('class', (positioned) => nodeClass(positioned.node, selection))
      .select('rect.selection-ring')
      .attr('x', -(nodeWidth / 2 + 5))
      .attr('y', -(nodeHeight / 2 + 5))
      .attr('width', nodeWidth + 10)
      .attr('height', nodeHeight + 10)
      .attr('rx', 11)
      .style('display', (positioned) => positioned.node.id === selection.selected?.id ? null : 'none');

    group.selectAll<SVGPathElement, PositionedEdge>('path.edge')
      .attr('class', (edge) => {
        const pathClass = pathSelectionClass(edge, selection);

        return ['edge', edgeType(edge.target.node), linkQuality(edge.target.node), pathClass]
          .filter((value) => value !== '')
          .join(' ');
      });
  }

  private selectionState(): GraphSelectionState {
    this.sweepHoverState();

    const hoveredNodeId = this.effectiveHoveredNodeId();
    const selectedId = hoveredNodeId ?? this.selectedNodeId();

    if (selectedId === null) {
      return {selected: null, path: new Set(), reachedController: false};
    }

    const selected = findNodeById(this.roots(), selectedId);

    if (selected === null) {
      return {selected: null, path: new Set(), reachedController: false};
    }

    const path = new Set<string>();
    let reachedController = false;
    let current: MwsNode | null = selected;

    while (current !== null) {
      path.add(current.id);
      reachedController = reachedController || current.isController;
      current = current.parent?.node ?? null;
    }

    return {selected, path, reachedController};
  }

  private sweepHoverState(): void {
    if (this.pointerNodeId !== null && findNodeById(this.roots(), this.pointerNodeId) === null) {
      this.pointerNodeId = null;
    }

    if (this.focusNodeId !== null && findNodeById(this.roots(), this.focusNodeId) === null) {
      this.focusNodeId = null;
    }

    if (this.activeSource === 'pointer' && this.pointerNodeId === null) {
      this.activeSource = this.focusNodeId === null ? null : 'focus';
    } else if (this.activeSource === 'focus' && this.focusNodeId === null) {
      this.activeSource = this.pointerNodeId === null ? null : 'pointer';
    } else if (this.activeSource === null) {
      this.activeSource = this.pointerNodeId === null
        ? this.focusNodeId === null ? null : 'focus'
        : 'pointer';
    }
  }

  private effectiveHoveredNodeId(): string | null {
    return this.activeSource === 'pointer'
      ? this.pointerNodeId
      : this.activeSource === 'focus'
      ? this.focusNodeId
      : null;
  }

  private nodeLabel(node: MwsNode): string {
    const labels = getNodeStatusLabels(node, (key, values) => this.t(key, values));
    const parts = [
      node.name,
      node.model ?? '',
      node.isController ? this.t('graph.controller') : this.t('graph.extender'),
      labels.online,
      this.hasTelemetryMarker(node) ? labels.telemetry : '',
      this.hasRemoteControlMarker(node) ? labels.remoteControl : '',
      hasUpdate(node) ? this.t('nodes.update-available') : '',
      labels.clients,
    ];

    return parts.filter((part) => part !== '').join(', ');
  }

  private hasTelemetryMarker(node: MwsNode): boolean {
    const state = node.mwsdStatus?.state;

    return this.extraFeaturesAvailability() === 'active' && !node.isController && node.isOnline
      && (state === 'stale' || state === 'offline');
  }

  private hasRemoteControlMarker(node: MwsNode): boolean {
    return this.extraFeaturesAvailability() === 'active' && !node.isController && node.isOnline
      && node.persistentSession === false;
  }

  private nodeIcons(node: MwsNode): NodeIcon[] {
    const icons: NodeIcon[] = [];

    if (node.isOnline && hasUpdate(node)) {
      icons.push({
        name: 'circle-arrow-up',
        label: this.t('nodes.update-available'),
        color: 'var(--mndw-info)',
      });
    }

    if (this.hasTelemetryMarker(node)) {
      const labels = getNodeStatusLabels(node, (key, values) => this.t(key, values));

      icons.push({
        name: 'activity',
        label: labels.telemetry,
        color: node.mwsdStatus?.state === 'offline' ? 'var(--mndw-danger)' : 'var(--mndw-warning)',
      });
    }

    if (this.hasRemoteControlMarker(node)) {
      const labels = getNodeStatusLabels(node, (key, values) => this.t(key, values));

      icons.push({
        name: 'unlink',
        label: labels.remoteControl,
        color: 'var(--mndw-warning)',
      });
    }

    return icons;
  }

  private refreshNodeIconHrefs(): void {
    this.zoomGroup?.selectAll<SVGSVGElement, NodeIcon>('svg.node-icon')
      .select('use')
      .attr('href', (icon) => {
        const href = mndwIconHref(icon.name);

        return href === '' ? null : href;
      });
  }

  protected t(key: string, values?: Record<string, unknown>): string {
    return this.translator.t(key, values);
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
    const positions = this.layout.nodes.map((positioned) =>
      effectivePosition(positioned, this.nodePositions(), this.dragPositions)
    );
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
