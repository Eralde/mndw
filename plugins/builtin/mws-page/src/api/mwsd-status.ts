import {normalizeMac} from './normalize';
import type {MwsNode, MwsRadioPower} from '../domain/mws/mws.types';

export const MWSD_STATUS_STALE_AFTER_MS = 90_000;

export type MwsdNodeState = 'starting' | 'live' | 'stale' | 'offline' | 'unavailable';

export interface MwsdNodeStatus {
  readonly state: MwsdNodeState;
  readonly lastTelemetryAt: number | null;
}

export type PersistentRadioPower = MwsRadioPower;

export interface PersistentSessionState {
  readonly live: boolean;
  readonly lastTelemetryAt: number | null;
  readonly power2g: PersistentRadioPower;
  readonly power5g: PersistentRadioPower;
}

export interface PersistentSessionSnapshot {
  readonly available: boolean;
  readonly sessions: ReadonlyMap<string, PersistentSessionState>;
}

export function newPersistentSessionSnapshot(
  available: boolean,
  sessions: ReadonlyMap<string, PersistentSessionState>,
): PersistentSessionSnapshot {
  return {available, sessions};
}

export function parsePersistentSessionsResponse(
  value: unknown,
  previous: PersistentSessionSnapshot,
): PersistentSessionSnapshot | null {
  const envelope = asRecord(value);
  const response = asRecord(envelope?.data) ?? envelope;

  if (typeof response?.persistentAvailable !== 'boolean' || !Array.isArray(response.persistentSessions)) {
    return null;
  }

  if (response.lastRefreshAt === null) {
    return response.persistentAvailable ? previous : newPersistentSessionSnapshot(false, previous.sessions);
  }

  if (parseTimestamp(response.lastRefreshAt) === null) {
    return null;
  }

  // Defensive-only: current backend emits unavailable together with null lastRefreshAt.
  if (!response.persistentAvailable) {
    return newPersistentSessionSnapshot(false, previous.sessions);
  }

  const sessions = new Map<string, PersistentSessionState>(
    [...previous.sessions].map(([mac, session]): [string, PersistentSessionState] => [
      mac,
      {...session, live: false},
    ]),
  );

  for (const rawSession of response.persistentSessions) {
    const entry = asRecord(rawSession);

    if (typeof entry?.mac !== 'string' || typeof entry.live !== 'boolean') {
      continue;
    }

    try {
      const mac = normalizeMac(entry.mac);
      const sampledAt = parseTimestamp(asRecord(entry.telemetry)?.sampledAt);

      sessions.set(mac, {
        live: entry.live,
        lastTelemetryAt: sampledAt ?? previous.sessions.get(mac)?.lastTelemetryAt ?? null,
        power2g: parsePersistentRadioPower(entry.power2g),
        power5g: parsePersistentRadioPower(entry.power5g),
      });
    } catch {
      continue;
    }
  }

  return newPersistentSessionSnapshot(true, sessions);
}

export function retainPersistentSessionsForNodes(
  roots: MwsNode[],
  snapshot: PersistentSessionSnapshot,
): PersistentSessionSnapshot {
  const macs = new Set<string>();
  const visit = (node: MwsNode): void => {
    if (!node.isController) {
      macs.add(node.mac);
    }

    node.children.forEach((link) => visit(link.node));
  };

  roots.forEach(visit);

  return newPersistentSessionSnapshot(
    snapshot.available,
    new Map([...snapshot.sessions].filter(([mac]) => macs.has(mac))),
  );
}

export function mergePersistentSessions(
  roots: MwsNode[],
  snapshot: PersistentSessionSnapshot,
  now: number,
): MwsNode[] {
  return roots.map((root) => mergePersistentNode(root, snapshot, now).node);
}

function mergePersistentNode(
  node: MwsNode,
  snapshot: PersistentSessionSnapshot,
  now: number,
): {node: MwsNode; changed: boolean} {
  const session = node.isController || !snapshot.available ? undefined : snapshot.sessions.get(node.mac);
  const unavailable = !node.isController && !snapshot.available;
  const persistentSession = session?.live;
  const mwsdStatus: MwsdNodeStatus | undefined = unavailable
    ? {state: 'unavailable', lastTelemetryAt: null}
    : session === undefined
    ? undefined
    : {state: deriveSessionState(session.live, session.lastTelemetryAt, now), lastTelemetryAt: session.lastTelemetryAt};
  const wifiPower = session === undefined ? undefined : {power2g: session.power2g, power5g: session.power5g};
  const children = node.children.map((link) => ({link, result: mergePersistentNode(link.node, snapshot, now)}));
  const changed = node.persistentSession !== persistentSession
    || !sameStatus(node.mwsdStatus, mwsdStatus)
    || !sameWifiPower(node.wifiPower, wifiPower)
    || children.some(({result}) => result.changed);

  if (!changed) {
    return {node, changed: false};
  }

  const next: MwsNode = {...node, persistentSession, mwsdStatus, wifiPower, parent: null, children: []};

  for (const {link, result} of children) {
    next.children.push({type: link.type, node: reparent(result.node, next, link.type)});
  }

  return {node: next, changed: true};
}

function deriveSessionState(live: boolean, lastTelemetryAt: number | null, now: number): MwsdNodeState {
  if (!live) {
    return 'offline';
  }

  if (lastTelemetryAt === null) {
    return 'starting';
  }

  return isTelemetryStale(lastTelemetryAt, now) ? 'stale' : 'live';
}

function isTelemetryStale(lastTelemetryAt: number, now: number): boolean {
  return now - lastTelemetryAt >= MWSD_STATUS_STALE_AFTER_MS;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) ? timestamp : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parsePersistentRadioPower(value: unknown): PersistentRadioPower {
  const entry = asRecord(value);

  if (entry === null) {
    return unavailableRadioPower();
  }

  const available = entry.available;
  const parsedValue = parsePowerValue(entry.value);

  if (typeof available !== 'boolean' || (entry.value !== undefined && entry.value !== null && parsedValue === null)) {
    return unavailableRadioPower();
  }

  if (available && parsedValue === null) {
    return unavailableRadioPower();
  }

  return {value: parsedValue, available};
}

function parsePowerValue(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function unavailableRadioPower(): PersistentRadioPower {
  return {value: null, available: false};
}

function sameStatus(left: MwsNode['mwsdStatus'], right: MwsNode['mwsdStatus']): boolean {
  return left?.state === right?.state && left?.lastTelemetryAt === right?.lastTelemetryAt;
}

function sameWifiPower(left: MwsNode['wifiPower'], right: MwsNode['wifiPower']): boolean {
  return left?.power2g.value === right?.power2g.value && left?.power2g.available === right?.power2g.available
    && left?.power5g.value === right?.power5g.value && left?.power5g.available === right?.power5g.available;
}

function reparent(node: MwsNode, parent: MwsNode, type: 'wired' | 'wireless'): MwsNode {
  const next: MwsNode = {...node, parent: {type, node: parent}, children: []};

  next.children = node.children.map((link) => ({type: link.type, node: reparent(link.node, next, link.type)}));

  return next;
}
