import {describe, expect, it} from 'vitest';
import {
  MWSD_STATUS_STALE_AFTER_MS,
  mergePersistentSessions,
  newPersistentSessionSnapshot,
  parsePersistentSessionsResponse,
  retainPersistentSessionsForNodes,
} from './mwsd-status';
import {normalizeMac} from './normalize';
import type {MwsNode} from '../domain/mws/mws.types';

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
    dualBand: false,
  };
}

describe('mwsd status', () => {
  it('parses target and authenticated-session counts for setup decisions', () => {
    const snapshot = parsePersistentSessionsResponse({
      lastRefreshAt: '2026-08-12T10:00:00Z',
      persistentAvailable: true,
      persistentTargetCount: 2,
      persistentSessionCount: 0,
      persistentSessions: [],
    }, newPersistentSessionSnapshot(true, new Map()));

    expect(snapshot).toMatchObject({available: true, targetCount: 2, sessionCount: 0, countsKnown: true});
  });

  it('marks a live session with fresh telemetry as live', () => {
    const now = Date.parse('2026-08-12T10:00:00Z');
    const snapshot = parsePersistentSessionsResponse({
      lastRefreshAt: new Date(now).toISOString(),
      persistentAvailable: true,
      persistentSessions: [{mac: MAC, live: true, telemetry: {sampledAt: new Date(now - 1_000).toISOString()}}],
    }, newPersistentSessionSnapshot(true, new Map()));

    const roots = mergePersistentSessions([node(MAC)], snapshot, now);

    expect(roots[0]?.mwsdStatus).toEqual({state: 'live', lastTelemetryAt: now - 1_000});
    expect(roots[0]?.persistentSession).toBe(true);
  });

  it('surfaces CPU, memory (as percent), and per-band Wi-Fi utilization onto the node', () => {
    const now = Date.parse('2026-08-12T10:00:00Z');
    const snapshot = parsePersistentSessionsResponse({
      lastRefreshAt: new Date(now).toISOString(),
      persistentAvailable: true,
      persistentSessions: [{
        mac: MAC,
        live: true,
        telemetry: {
          sampledAt: new Date(now - 1_000).toISOString(),
          system: {memtotal: 1000},
          cpuRrd: {data: [{t: 100, v: 27}, {t: 103, v: 31}]},
          memoryRrd: {data: [{t: 100, v: 500}, {t: 103, v: 750}]},
          wifiUtil: [
            {interface: 'WifiMaster0', t: [200, 203], load: [28, 31]},
            {interface: 'WifiMaster1', t: [200], load: [10]},
          ],
        },
      }],
    }, newPersistentSessionSnapshot(true, new Map()));

    const telemetry = mergePersistentSessions([node(MAC)], snapshot, now)[0]?.liveTelemetry;
    const anchor = now - 1_000;

    expect(telemetry?.sampledAt).toBe(anchor);
    expect(telemetry?.cpu).toEqual({times: [anchor - 3_000, anchor], values: [27, 31]});
    expect(telemetry?.memory).toEqual({times: [anchor - 3_000, anchor], values: [50, 75]});
    // Newest Wi-Fi sample is anchored at sampledAt; the earlier one is 3s before.
    expect(telemetry?.wifi24).toEqual({times: [anchor - 3_000, anchor], values: [28, 31]});
    expect(telemetry?.wifi5).toEqual({times: [anchor], values: [10]});
  });

  it('drops memory history when the total is unknown but keeps other series', () => {
    const now = Date.parse('2026-08-12T10:00:00Z');
    const snapshot = parsePersistentSessionsResponse({
      lastRefreshAt: new Date(now).toISOString(),
      persistentAvailable: true,
      persistentSessions: [{
        mac: MAC,
        live: true,
        telemetry: {
          sampledAt: new Date(now).toISOString(),
          cpuRrd: {data: [{t: 100, v: 5}]},
          memoryRrd: {data: [{t: 100, v: 500}]},
        },
      }],
    }, newPersistentSessionSnapshot(true, new Map()));

    const telemetry = mergePersistentSessions([node(MAC)], snapshot, now)[0]?.liveTelemetry;

    expect(telemetry?.cpu).toEqual({times: [now], values: [5]});
    expect(telemetry?.memory).toEqual({times: [], values: []});
    expect(telemetry?.wifi24).toEqual({times: [], values: []});
  });

  it('ages cached live telemetry to stale at merge time', () => {
    const now = Date.parse('2026-08-12T10:00:00Z');
    const snapshot = parsePersistentSessionsResponse({
      lastRefreshAt: new Date(now).toISOString(),
      persistentAvailable: true,
      persistentSessions: [{mac: MAC, live: true, telemetry: {sampledAt: new Date(now - 1_000).toISOString()}}],
    }, newPersistentSessionSnapshot(true, new Map()));
    const roots = [node(MAC)];

    expect(mergePersistentSessions(roots, snapshot, now)[0]?.mwsdStatus?.state).toBe('live');
    expect(mergePersistentSessions(roots, snapshot, now + MWSD_STATUS_STALE_AFTER_MS)[0]?.mwsdStatus?.state)
      .toBe('stale');
  });

  it('preserves the controller\'s direct-RCI telemetry through a persistent-session merge', () => {
    const controller = {...node('ctrl-mac', true), liveTelemetry: {
      sampledAt: 5_000,
      cpu: {times: [1], values: [7]},
      memory: {times: [], values: []},
      wifi24: {times: [1], values: [22]},
      wifi5: {times: [], values: []},
    }};
    const extender = node(MAC);

    controller.children = [{type: 'wireless' as const, node: extender}];

    const snapshot = parsePersistentSessionsResponse({
      lastRefreshAt: '2026-08-12T10:00:00Z',
      persistentAvailable: true,
      persistentSessions: [{mac: MAC, live: true, telemetry: {sampledAt: '2026-08-12T10:00:00Z'}}],
    }, newPersistentSessionSnapshot(true, new Map()));

    const merged = mergePersistentSessions([controller], snapshot, Date.parse('2026-08-12T10:00:00Z'));

    expect(merged[0]?.liveTelemetry?.wifi24.values).toEqual([22]);
    expect(merged[0]?.persistentSession).toBeUndefined();
  });

  it('marks non-live sessions offline', () => {
    const snapshot = parsePersistentSessionsResponse({
      lastRefreshAt: '2026-08-12T10:00:00Z',
      persistentAvailable: true,
      persistentSessions: [{mac: MAC, live: false}],
    }, newPersistentSessionSnapshot(true, new Map()));

    expect(mergePersistentSessions([node(MAC)], snapshot, Date.now())[0]?.mwsdStatus?.state).toBe('offline');
  });

  it('retains the last-good timestamp when a present session omits telemetry', () => {
    const mac = normalizeMac(MAC);
    const sampledAt = Date.parse('2026-08-12T09:59:59Z');
    const previous = parsePersistentSessionsResponse({
      lastRefreshAt: '2026-08-12T09:59:59Z',
      persistentAvailable: true,
      persistentSessions: [{mac, live: true, telemetry: {sampledAt: new Date(sampledAt).toISOString()}}],
    }, newPersistentSessionSnapshot(true, new Map()));
    const next = parsePersistentSessionsResponse({
      lastRefreshAt: '2026-08-12T10:00:00Z',
      persistentAvailable: true,
      persistentSessions: [{mac, live: true}],
    }, previous);

    expect(next.sessions.get(mac)?.lastTelemetryAt).toBe(sampledAt);
  });

  it('turns absent sessions into offline tombstones until topology pruning', () => {
    const previous = parsePersistentSessionsResponse({
      lastRefreshAt: '2026-08-12T09:59:59Z',
      persistentAvailable: true,
      persistentSessions: [{mac: MAC, live: true}],
    }, newPersistentSessionSnapshot(true, new Map()));
    const reconciled = parsePersistentSessionsResponse({
      lastRefreshAt: '2026-08-12T10:00:00Z',
      persistentAvailable: true,
      persistentSessions: [],
    }, previous);

    expect(reconciled.sessions.get(MAC)).toMatchObject({live: false});
    expect(mergePersistentSessions([node(MAC)], reconciled, Date.now())[0]?.mwsdStatus?.state).toBe('offline');
    expect(retainPersistentSessionsForNodes([], reconciled).sessions.has(MAC)).toBe(false);
  });

  it('returns null for malformed envelopes', () => {
    const previous = parsePersistentSessionsResponse({
      lastRefreshAt: '2026-08-12T09:59:59Z',
      persistentAvailable: true,
      persistentSessions: [{mac: MAC, live: false}],
    }, newPersistentSessionSnapshot(true, new Map()));

    const next = parsePersistentSessionsResponse({lastRefreshAt: '2026-08-12T10:00:00Z'}, previous);

    expect(next).toBeNull();
  });

  it('returns null for invalid non-null timestamps', () => {
    const previous = newPersistentSessionSnapshot(true, new Map());

    expect(parsePersistentSessionsResponse({
      lastRefreshAt: 'not-a-timestamp',
      persistentAvailable: true,
      persistentSessions: [],
    }, previous)).toBeNull();
  });

  it('preserves the prior snapshot until first enumeration completes', () => {
    const previous = parsePersistentSessionsResponse({
      lastRefreshAt: '2026-08-12T09:59:59Z',
      persistentAvailable: true,
      persistentSessions: [{mac: MAC, live: true}],
    }, newPersistentSessionSnapshot(true, new Map()));

    const next = parsePersistentSessionsResponse({
      lastRefreshAt: null,
      persistentAvailable: true,
      persistentSessions: [],
    }, previous);

    expect(next).toBe(previous);
  });

  it('marks missing persistent source unavailable while preserving sessions', () => {
    const previous = parsePersistentSessionsResponse({
      lastRefreshAt: '2026-08-12T09:59:59Z',
      persistentAvailable: true,
      persistentSessions: [{mac: MAC, live: true}],
    }, newPersistentSessionSnapshot(true, new Map()));
    const snapshot = parsePersistentSessionsResponse({
      lastRefreshAt: null,
      persistentAvailable: false,
      persistentSessions: [],
    }, previous);
    const roots = mergePersistentSessions([node(MAC)], snapshot, Date.now());

    expect(snapshot.available).toBe(false);
    expect(snapshot.sessions).toBe(previous.sessions);
    expect(roots[0]?.mwsdStatus).toEqual({state: 'unavailable', lastTelemetryAt: null});
    expect(roots[0]?.persistentSession).toBeUndefined();
  });

  it('omits persistent-derived fields on controller nodes', () => {
    const roots = mergePersistentSessions(
      [node(MAC, true)],
      parsePersistentSessionsResponse({
        lastRefreshAt: '2026-08-12T10:00:00Z',
        persistentAvailable: true,
        persistentSessions: [{mac: MAC, live: true}],
      }, newPersistentSessionSnapshot(true, new Map())),
      Date.now(),
    );

    expect(roots[0]?.mwsdStatus).toBeUndefined();
    expect(roots[0]?.persistentSession).toBeUndefined();
    expect(roots[0]?.wifiPower).toBeUndefined();
  });
});
