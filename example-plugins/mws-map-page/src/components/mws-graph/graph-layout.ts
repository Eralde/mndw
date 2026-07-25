import {coordGreedy, decrossOpt, graphStratify, layeringLongestPath, sugiyama} from 'd3-dag';
import type {MwsNode} from '../../domain/mws/mws.types';

export interface GraphLayoutConfig {
  nodeWidth: number;
  nodeHeight: number;
  nodePadding: number;
  treeSpacing: number;
}

export const DEFAULT_LAYOUT_CONFIG: GraphLayoutConfig = {
  nodeWidth: 140,
  nodeHeight: 64,
  nodePadding: 24,
  treeSpacing: 120,
};

export interface PositionedNode {
  node: MwsNode;
  x: number;
  y: number;
}

export interface PositionedEdge {
  source: PositionedNode;
  target: PositionedNode;
  type: 'wired' | 'wireless';
}

export interface GraphLayout {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
}

interface StratumDatum {
  id: string;
  parentIds: string[];
  node: MwsNode;
}

function flatten(root: MwsNode): StratumDatum[] {
  const result: StratumDatum[] = [];
  const visit = (node: MwsNode, parentId: string | null): void => {
    result.push({id: node.id, parentIds: parentId === null ? [] : [parentId], node});

    for (const link of node.children) {
      visit(link.node, node.id);
    }
  };

  visit(root, null);

  return result;
}

export function layoutForest(roots: MwsNode[], config: GraphLayoutConfig = DEFAULT_LAYOUT_CONFIG): GraphLayout {
  if (roots.length === 0) {
    return {nodes: [], edges: [], width: 0, height: 0};
  }

  const trees = roots.map(flatten).sort((a, b) => b.length - a.length);
  const largestTree = trees[0];
  const ordered: StratumDatum[][] = [];

  for (const tree of trees) {
    if (ordered.length % 2 === 0) {
      ordered.push(tree);
    } else {
      ordered.unshift(tree);
    }
  }

  const nodes: PositionedNode[] = [];
  const edges: PositionedEdge[] = [];
  let offsetX = 0;
  let maxHeight = 0;

  for (const data of ordered) {
    const dag = graphStratify()(data);
    const layout = sugiyama()
      .layering(layeringLongestPath())
      .decross(decrossOpt())
      .coord(coordGreedy())
      .nodeSize([config.nodeWidth + config.nodePadding, config.nodeHeight + config.nodePadding])
      .gap([config.nodePadding, config.nodePadding]);
    const {width, height} = layout(dag);
    const positioned = new Map<string, PositionedNode>();

    for (const dagNode of dag.nodes()) {
      const datum = dagNode.data;
      const entry: PositionedNode = {node: datum.node, x: offsetX + dagNode.x, y: dagNode.y};

      positioned.set(datum.id, entry);
      nodes.push(entry);
    }

    for (const entry of positioned.values()) {
      const parentLink = entry.node.parent;

      if (parentLink === null) {
        continue;
      }

      const source = positioned.get(parentLink.node.id);

      if (source !== undefined) {
        edges.push({source, target: entry, type: parentLink.type});
      }
    }

    offsetX += width + config.treeSpacing;
    maxHeight = Math.max(maxHeight, height);
  }

  const baseWidth = Math.max(0, offsetX - config.treeSpacing);
  const largestIds = new Set(largestTree.map((datum) => datum.id));
  const largestNodes = nodes.filter((positioned) => largestIds.has(positioned.node.id));
  const largestCenter = (Math.min(...largestNodes.map((positioned) => positioned.x))
    + Math.max(...largestNodes.map((positioned) => positioned.x))) / 2;
  const contentMax = Math.max(...nodes.map((positioned) => positioned.x));
  const width = Math.max(baseWidth, contentMax, 2 * largestCenter, 2 * (contentMax - largestCenter));
  const centerShift = width / 2 - largestCenter;

  for (const positioned of nodes) {
    positioned.x += centerShift;
  }

  return {nodes, edges, width, height: maxHeight};
}
