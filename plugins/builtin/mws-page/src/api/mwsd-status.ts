import {normalizeMac} from './normalize';
import type {MwsLiveTelemetry, MwsNode, MwsRadioPower, MwsUtilSeries} from '../domain/mws/mws.types';

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
  readonly telemetry: MwsLiveTelemetry | null;
}

export interface PersistentSessionSnapshot {
  readonly available: boolean;
  readonly targetCount: number;
  readonly sessionCount: number;
  readonly countsKnown: boolean;
  readonly sessions: ReadonlyMap<string, PersistentSessionState>;
}

export function newPersistentSessionSnapshot(
  available: boolean,
  sessions: ReadonlyMap<string, PersistentSessionState>,
  targetCount = 0,
  sessionCount = 0,
  countsKnown = true,
): PersistentSessionSnapshot {
  return {available, targetCount, sessionCount, countsKnown, sessions};
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

  const targetCount = parseNonNegativeCount(response.persistentTargetCount);
  const sessionCount = parseNonNegativeCount(response.persistentSessionCount);
  const countsKnown = targetCount !== null && sessionCount !== null;

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
      const telemetryRecord = asRecord(entry.telemetry);
      const sampledAt = parseTimestamp(telemetryRecord?.sampledAt);

      sessions.set(mac, {
        live: entry.live,
        lastTelemetryAt: sampledAt ?? previous.sessions.get(mac)?.lastTelemetryAt ?? null,
        power2g: parsePersistentRadioPower(entry.power2g),
        power5g: parsePersistentRadioPower(entry.power5g),
        telemetry: parseLiveTelemetry(telemetryRecord, sampledAt) ?? previous.sessions.get(mac)?.telemetry ?? null,
      });
    } catch {
      continue;
    }
  }

  return newPersistentSessionSnapshot(true, sessions, targetCount ?? 0, sessionCount ?? 0, countsKnown);
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
    snapshot.targetCount,
    snapshot.sessionCount,
    snapshot.countsKnown,
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
  // The controller has no persistent session; its live telemetry is set at build
  // time from direct RCI calls, so preserve it here instead of clearing it.
  const liveTelemetry = node.isController ? node.liveTelemetry : session?.telemetry ?? undefined;
  const children = node.children.map((link) => ({link, result: mergePersistentNode(link.node, snapshot, now)}));
  const changed = node.persistentSession !== persistentSession
    || !sameStatus(node.mwsdStatus, mwsdStatus)
    || !sameWifiPower(node.wifiPower, wifiPower)
    || !sameLiveTelemetry(node.liveTelemetry, liveTelemetry)
    || children.some(({result}) => result.changed);

  if (!changed) {
    return {node, changed: false};
  }

  const next: MwsNode = {...node, persistentSession, mwsdStatus, wifiPower, liveTelemetry, parent: null, children: []};

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

function parseNonNegativeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
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

const EMPTY_UTIL_SERIES: MwsUtilSeries = {times: [], values: []};

/**
 * Builds live telemetry from the persistent-session payload shape
 * `{system:{memtotal}, cpuRrd, memoryRrd, wifiUtil:[{interface,t,load}]}`. Shared
 * with the controller path, which assembles the same shape from direct RCI calls.
 */
export function parseLiveTelemetry(
  telemetry: Record<string, unknown> | null,
  sampledAt: number | null,
): MwsLiveTelemetry | null {
  if (telemetry === null) {
    return null;
  }

  const system = asRecord(telemetry.system);
  const memTotal = toFiniteNumber(system?.memtotal);
  const memoryUsed = parseRrdSeries(telemetry.memoryRrd, sampledAt);
  const memory: MwsUtilSeries = memTotal !== null && memTotal > 0
    ? {times: memoryUsed.times, values: memoryUsed.values.map((used) => (used / memTotal) * 100)}
    : EMPTY_UTIL_SERIES;
  const wifi = parseWifiUtil(telemetry.wifiUtil, sampledAt);

  return {
    sampledAt,
    cpu: parseRrdSeries(telemetry.cpuRrd, sampledAt),
    memory,
    wifi24: wifi.WifiMaster0 ?? EMPTY_UTIL_SERIES,
    wifi5: wifi.WifiMaster1 ?? EMPTY_UTIL_SERIES,
  };
}

/** Maps relative device-seconds to wall-clock epoch-ms, anchoring the newest sample at `sampledAt`. */
function toEpochTimes(relativeSeconds: readonly number[], sampledAt: number | null): number[] {
  if (sampledAt === null || relativeSeconds.length === 0) {
    return [];
  }

  const last = relativeSeconds[relativeSeconds.length - 1];

  return relativeSeconds.map((seconds) => sampledAt + (seconds - last) * 1000);
}

function parseRrdSeries(value: unknown, sampledAt: number | null): MwsUtilSeries {
  const data = asRecord(value)?.data;

  if (!Array.isArray(data)) {
    return EMPTY_UTIL_SERIES;
  }

  const relativeTimes: number[] = [];
  const values: number[] = [];

  for (const tick of data) {
    const record = asRecord(tick);
    const parsedValue = toFiniteNumber(record?.v);
    const parsedTime = toFiniteNumber(record?.t);

    if (parsedValue !== null && parsedTime !== null) {
      relativeTimes.push(parsedTime);
      values.push(parsedValue);
    }
  }

  return {times: toEpochTimes(relativeTimes, sampledAt), values};
}

function parseWifiUtil(
  value: unknown,
  sampledAt: number | null,
): {WifiMaster0?: MwsUtilSeries; WifiMaster1?: MwsUtilSeries} {
  if (!Array.isArray(value)) {
    return {};
  }

  const result: {WifiMaster0?: MwsUtilSeries; WifiMaster1?: MwsUtilSeries} = {};

  for (const item of value) {
    const record = asRecord(item);
    const iface = record?.interface;

    if ((iface === 'WifiMaster0' || iface === 'WifiMaster1') && Array.isArray(record?.load)) {
      const values = record.load.filter((entry): entry is number =>
        typeof entry === 'number' && Number.isFinite(entry)
      );
      const relativeTimes = Array.isArray(record.t)
        ? record.t.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
        : [];

      result[iface] = {
        times: relativeTimes.length === values.length ? toEpochTimes(relativeTimes, sampledAt) : [],
        values,
      };
    }
  }

  return result;
}

// RRD ticks arrive with `t`/`v` as either numbers or numeric strings, so parse
// both forms.
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function sameStatus(left: MwsNode['mwsdStatus'], right: MwsNode['mwsdStatus']): boolean {
  return left?.state === right?.state && left?.lastTelemetryAt === right?.lastTelemetryAt;
}

function sameLiveTelemetry(left: MwsNode['liveTelemetry'], right: MwsNode['liveTelemetry']): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  // Each poll rebuilds the series arrays, so a stable sampledAt is the cheap,
  // reliable signal that the underlying samples have not changed.
  return left.sampledAt === right.sampledAt;
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
