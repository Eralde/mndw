import {describe, expect, it} from 'vitest';
import type {MwsNode} from '../../domain/mws/mws.types';
import {edgePath, nodeClass, pathSelectionClass} from './graph-rendering';

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

  it('projects selected path classes for nodes and edges', () => {
    const root = node('root', true);
    const child = node('child');
    const selection = {selected: child, path: new Set(['root', 'child']), reachedController: true};

    expect(nodeClass(child, selection)).toContain('selected');
    expect(pathSelectionClass({source: {node: root}, target: {node: child}}, selection)).toBe('on-path');
  });
});
