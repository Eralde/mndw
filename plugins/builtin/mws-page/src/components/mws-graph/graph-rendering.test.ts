import {describe, expect, it} from 'vitest';
import type {MwsNode} from '../../domain/mws/mws.types';
import {DEFAULT_LAYOUT_CONFIG} from './graph-layout';
import {
  EDGE_LABEL_GAP,
  edgeLabelPosition,
  edgeMidpoint,
  edgePath,
  effectivePosition,
  nodeClass,
  pathSelectionClass,
  signalBars,
} from './graph-rendering';

const node = (id: string, isController = false): MwsNode => {
  return {
    id,
    name: id,
    model: null,
    isController,
    isOnline: true,
    children: [],
    parent: null,
    clients: [],
    backhaul: null,
    mwsdStatus: undefined,
    persistentSession: undefined,
  } as MwsNode;
};

describe('graph rendering helpers', () => {
  it('builds a stable edge path from effective positions', () => {
    expect(edgePath({source: {x: 10, y: 20}, target: {x: 30, y: 80}})).toBe('M 10 52 C 10 50 30 50 30 48');
  });

  it('places an edge label above the top-left corner of the target card', () => {
    expect(edgeLabelPosition({x: 100, y: 200})).toEqual({
      x: 100 - DEFAULT_LAYOUT_CONFIG.nodeWidth / 2,
      y: 200 - DEFAULT_LAYOUT_CONFIG.nodeHeight / 2 - EDGE_LABEL_GAP,
    });
  });

  it('derives the label position from a dragged node position', () => {
    const positioned = {node: node('child'), x: 0, y: 0};
    const dragged = new Map([['child', {x: 300, y: 400}]]);

    expect(edgeLabelPosition(effectivePosition(positioned, new Map(), dragged))).toEqual({
      x: 300 - DEFAULT_LAYOUT_CONFIG.nodeWidth / 2,
      y: 400 - DEFAULT_LAYOUT_CONFIG.nodeHeight / 2 - EDGE_LABEL_GAP,
    });
  });

  it('projects selected path classes for nodes and edges', () => {
    const root = node('root', true);
    const child = node('child');
    const selection = {selected: child, path: new Set(['root', 'child']), reachedController: true};

    expect(nodeClass(child, selection)).toContain('selected');
    expect(pathSelectionClass({source: {node: root}, target: {node: child}}, selection)).toBe('on-path');
  });

  describe('edgeMidpoint', () => {
    it('returns the x-center for a straight vertical edge', () => {
      const mid = edgeMidpoint({x: 100, y: 0}, {x: 100, y: 200});

      expect(mid.x).toBeCloseTo(100);
    });

    it('returns x-center between horizontally offset endpoints', () => {
      const mid = edgeMidpoint({x: 0, y: 0}, {x: 200, y: 200});

      expect(mid.x).toBeCloseTo(100);
    });

    it('returns a y value between the two endpoints', () => {
      const mid = edgeMidpoint({x: 100, y: 0}, {x: 100, y: 400});

      expect(mid.y).toBeGreaterThan(0);
      expect(mid.y).toBeLessThan(400);
    });
  });

  describe('signalBars', () => {
    it('returns 3 for good quality', () => {
      expect(signalBars('good')).toBe(3);
    });

    it('returns 2 for fair quality', () => {
      expect(signalBars('fair')).toBe(2);
    });

    it('returns 1 for weak quality', () => {
      expect(signalBars('weak')).toBe(1);
    });

    it('returns 1 for unknown quality', () => {
      expect(signalBars('unknown')).toBe(1);
    });
  });
});
