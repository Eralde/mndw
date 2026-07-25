import {describe, expect, it} from 'vitest';
import {normalizeMembers} from '../../api/normalize';
import {loadFixture} from '../../fixtures/load';
import {buildMap} from '../../domain/mws/map-builder';
import type {ControllerInfo} from '../../domain/mws/mws.types';
import {layoutForest} from './graph-layout';

const CONTROLLER: ControllerInfo = {
  mac: '02:7d:4a:91:c3:10',
  ip: null,
  name: 'Router',
  model: null,
  firmware: null,
  interfaceUptime: null,
  isOnline: true,
};

describe('layoutForest', () => {
  it('positions every node and types every edge for the fixture chain', () => {
    const roots = buildMap(normalizeMembers(loadFixture('show-mws-member.json')), [], CONTROLLER);
    const layout = layoutForest(roots);

    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges.map((edge) => edge.type).sort()).toEqual(['wired', 'wireless']);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);

    for (const positioned of layout.nodes) {
      expect(Number.isFinite(positioned.x)).toBe(true);
      expect(Number.isFinite(positioned.y)).toBe(true);
    }

    const byId = new Map(layout.nodes.map((positioned) => [positioned.node.id, positioned]));
    const controller = byId.get('02:7d:4a:91:c3:10');
    const buddy = byId.get('02:7d:4a:91:c3:21');

    expect((controller as {y: number}).y).toBeLessThan((buddy as {y: number}).y);
  });

  it('lays out detached trees side by side without overlap', () => {
    const offline = {cid: 'c1', mac: 'aa:00:00:00:00:01'};
    const roots = buildMap(
      normalizeMembers([...loadFixture<object[]>('show-mws-member.json'), offline]),
      [],
      CONTROLLER,
    );
    const layout = layoutForest(roots);
    const xs = layout.nodes.map((positioned) => positioned.x);

    expect(layout.nodes).toHaveLength(4);
    expect(new Set(xs.map((x) => Math.round(x))).size).toBeGreaterThan(1);

    const largestTreeIds = new Set([
      '02:7d:4a:91:c3:10',
      '02:7d:4a:91:c3:21',
      '02:7d:4a:91:c3:32',
    ]);
    const largestTreeXs = layout.nodes
      .filter((positioned) => largestTreeIds.has(positioned.node.id))
      .map((positioned) => positioned.x);
    const largestTreeCenter = (Math.min(...largestTreeXs) + Math.max(...largestTreeXs)) / 2;

    expect(largestTreeCenter).toBeCloseTo(layout.width / 2, 5);
  });

  it('handles an empty forest', () => {
    expect(layoutForest([])).toEqual({nodes: [], edges: [], width: 0, height: 0});
  });
});
