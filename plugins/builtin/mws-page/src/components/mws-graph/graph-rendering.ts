import type {MwsNode} from '../../domain/mws/mws.types';
import {DEFAULT_LAYOUT_CONFIG, type PositionedEdge, type PositionedNode} from './graph-layout';
import type {LinkQuality} from './link-quality';

export interface GraphSelectionState {
  selected: MwsNode | null;
  path: Set<string>;
  reachedController: boolean;
}

export interface GraphPosition {
  x: number;
  y: number;
}

export function edgePath(edge: {source: GraphPosition; target: GraphPosition}): string {
  const half = DEFAULT_LAYOUT_CONFIG.nodeHeight / 2;
  const y1 = edge.source.y + half;
  const y2 = edge.target.y - half;
  const midY = (y1 + y2) / 2;

  return `M ${edge.source.x} ${y1} C ${edge.source.x} ${midY} ${edge.target.x} ${midY} ${edge.target.x} ${y2}`;
}

export function nodeClass(node: MwsNode, selection: GraphSelectionState): string {
  const stateClass = [
    node.isController ? 'controller' : '',
    node.isOnline ? '' : 'offline',
    node.mwsdStatus === undefined || node.isController ? '' : `mwsd-${node.mwsdStatus.state}`,
    node.persistentSession === undefined || node.isController
      ? ''
      : node.persistentSession
      ? 'persistent-live'
      : 'persistent-failing',
    selection.selected === null ? '' : node.id === selection.selected.id
      ? 'selected'
      : !selection.reachedController
      ? ''
      : selection.path.has(node.id)
      ? 'on-path'
      : '',
  ].filter((value) => value !== '');

  return ['node', ...stateClass].join(' ');
}

export function pathSelectionClass(
  edge: Pick<PositionedEdge, 'source' | 'target'>,
  selection: GraphSelectionState,
): string {
  if (selection.selected === null || !selection.reachedController) {
    return '';
  }

  return selection.path.has(edge.source.node.id) && selection.path.has(edge.target.node.id) ? 'on-path' : '';
}

export function effectivePosition(
  positioned: PositionedNode,
  manual: ReadonlyMap<string, GraphPosition>,
  dragged: ReadonlyMap<string, GraphPosition>,
): GraphPosition {
  const drag = dragged.get(positioned.node.id);

  if (drag !== undefined) {
    return drag;
  }

  return manual.get(positioned.node.id) ?? {x: positioned.x, y: positioned.y};
}

export function edgeMidpoint(source: GraphPosition, target: GraphPosition): GraphPosition {
  const half = DEFAULT_LAYOUT_CONFIG.nodeHeight / 2;
  const y1 = source.y + half;
  const y2 = target.y - half;
  const midY = (y1 + y2) / 2;
  const t = 0.5;
  const mt = 1 - t;
  const x = mt * mt * mt * source.x
    + 3 * mt * mt * t * source.x
    + 3 * mt * t * t * target.x
    + t * t * t * target.x;
  const y = mt * mt * mt * y1
    + 3 * mt * mt * t * midY
    + 3 * mt * t * t * midY
    + t * t * t * y2;

  return {x, y};
}

export const SIGNAL_ICON_PATHS = [
  'M -7 6 L -7 10',
  'M 0 2 L 0 10',
  'M 7 -2 L 7 10',
] as const;

export const ETHERNET_ICON_PATH = 'M -7 -4 h 14 v 8 h -14 Z M -4 4 v 3 M 0 4 v 3 M 4 4 v 3 M -4 -4 v -2 M 4 -4 v -2';

export function signalBars(quality: LinkQuality): number {
  return quality === 'good' ? 3 : quality === 'fair' ? 2 : 1;
}
