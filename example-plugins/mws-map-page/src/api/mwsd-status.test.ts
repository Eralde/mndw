import {describe, expect, it} from 'vitest';
import {mergeMwsdStatuses, parseMwsdNodesResponse} from './mwsd-status';
import type {MwsNode} from '../domain/mws/mws.types';

const NOW = Date.parse('2026-08-03T18:00:00Z');
const MAC = 'aa:bb:cc:dd:ee:ff';

function node(id: string, isController = false): MwsNode {
  return {
    id,
    cid: isController ? null : 'cid-1',
    name: isController ? 'Controller' : 'Extender',
    model: null,
    ip: null,
    mac: id,
    isController,
    isOnline: true,
    fw: null,
    fwAvailable: null,
    system: null,
    backhaul: null,
    parent: null,
    children: [],
    clients: [],
  };
}

describe('mwsd status', () => {
  it('normalizes timestamps and joins status by MAC even when nodeId is a CID', () => {
    const snapshot = parseMwsdNodesResponse({
      credState: 'present',
      lastRefreshAt: '2026-08-03T17:59:59+02:00',
      nodes: [{nodeId: 'cid-1', mac: MAC.toUpperCase(), state: 'live', lastSuccessAt: '2026-08-03T19:59:00+02:00'}],
    }, NOW);

    expect(snapshot.lastRefreshAt).toBe(Date.parse('2026-08-03T15:59:59Z'));
    expect(snapshot.nodes.get(MAC)).toEqual({state: 'live', lastSuccessAt: Date.parse('2026-08-03T17:59:00Z')});

    const roots = mergeMwsdStatuses([node(MAC)], snapshot, NOW);

    expect(roots[0]?.mwsdStatus).toEqual({state: 'live', lastSuccessAt: Date.parse('2026-08-03T17:59:00Z')});
  });

  it('accepts the mwsd-client success envelope', () => {
    const snapshot = parseMwsdNodesResponse({
      ok: true,
      status: 200,
      data: {credState: 'present', nodes: [{mac: MAC, state: 'authenticating', lastSuccessAt: null}]},
    }, NOW);

    expect(snapshot.credState).toBe('present');
    expect(snapshot.nodes.get(MAC)?.state).toBe('starting');
  });

  it('projects stale, reauthenticating, and first-check states', () => {
    const snapshot = parseMwsdNodesResponse({
      credState: 'present',
      nodes: [
        {mac: 'aa:bb:cc:dd:ee:01', state: 'live', lastSuccessAt: '2026-08-03T17:57:00Z'},
        {mac: 'aa:bb:cc:dd:ee:02', state: 'reauthenticating', lastSuccessAt: '2026-08-03T17:59:00Z'},
        {mac: 'aa:bb:cc:dd:ee:03', state: 'reauthenticating', lastSuccessAt: null},
        {mac: 'aa:bb:cc:dd:ee:04', state: 'live', lastSuccessAt: null},
      ],
    }, NOW);

    expect(snapshot.nodes.get('aa:bb:cc:dd:ee:01')?.state).toBe('stale');
    expect(snapshot.nodes.get('aa:bb:cc:dd:ee:02')?.state).toBe('stale');
    expect(snapshot.nodes.get('aa:bb:cc:dd:ee:03')?.state).toBe('starting');
    expect(snapshot.nodes.get('aa:bb:cc:dd:ee:04')?.state).toBe('starting');
  });

  it('marks known extenders offline when credentials are absent or invalid', () => {
    const snapshot = parseMwsdNodesResponse({credState: 'invalid', nodes: []}, NOW);
    const roots = mergeMwsdStatuses([node('11:22:33:44:55:66', true), node(MAC)], snapshot, NOW);

    expect(roots[0]?.mwsdStatus).toBeUndefined();
    expect(roots[1]?.mwsdStatus).toEqual({state: 'offline', lastSuccessAt: null});
  });

  it('ignores malformed backend entries and preserves topology links', () => {
    const child = node(MAC);
    const controller = node('11:22:33:44:55:66', true);

    child.parent = {type: 'wired', node: controller};
    controller.children = [{type: 'wired', node: child}];

    const snapshot = parseMwsdNodesResponse({
      credState: 'present',
      nodes: [
        {mac: 'not-a-mac', state: 'live', lastSuccessAt: '2026-08-03T17:59:00Z'},
        {mac: MAC, state: 'node_offline', lastSuccessAt: null},
      ],
    }, NOW);

    const roots = mergeMwsdStatuses([controller], snapshot, NOW);

    expect(roots[0]?.children[0]?.node.mwsdStatus?.state).toBe('offline');
    expect(roots[0]?.children[0]?.node.parent?.node).toBe(roots[0]);
  });
});
