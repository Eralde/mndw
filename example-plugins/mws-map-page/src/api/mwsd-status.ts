import {normalizeMac} from './normalize';
import type {MwsNode} from '../domain/mws/mws.types';

export const MWSD_STATUS_STALE_AFTER_MS = 90_000;

export type MwsdNodeState = 'starting' | 'live' | 'stale' | 'offline';
export type MwsdCredentialState = 'present' | 'invalid' | 'absent';

export interface MwsdNodeStatus {
  readonly state: MwsdNodeState;
  readonly lastSuccessAt: number | null;
}

export interface MwsdStatusSnapshot {
  readonly credState: MwsdCredentialState;
  readonly lastRefreshAt: number | null;
  readonly nodes: ReadonlyMap<string, MwsdNodeStatus>;
}

export function parseMwsdNodesResponse(value: unknown, now: number): MwsdStatusSnapshot {
  const envelope = asRecord(value);
  const response = asRecord(envelope?.data) ?? envelope;
  const credState = parseCredentialState(response?.credState);
  const lastRefreshAt = parseTimestamp(response?.lastRefreshAt);
  const nodes = new Map<string, MwsdNodeStatus>();
  const rawNodes = response?.nodes;

  if (Array.isArray(rawNodes)) {
    for (const rawNode of rawNodes) {
      const entry = asRecord(rawNode);
      const rawMac = entry?.mac;

      if (typeof rawMac !== 'string') {
        continue;
      }

      let mac: string;

      try {
        mac = normalizeMac(rawMac);
      } catch {
        continue;
      }

      const lastSuccessAt = parseTimestamp(entry?.lastSuccessAt);

      nodes.set(mac, {state: projectState(entry?.state, lastSuccessAt, credState, now), lastSuccessAt});
    }
  }

  return {credState, lastRefreshAt, nodes};
}

export function mergeMwsdStatuses(roots: MwsNode[], snapshot: MwsdStatusSnapshot, now: number): MwsNode[] {
  return roots.map((root) => mergeNode(root, snapshot, now).node);
}

function mergeNode(node: MwsNode, snapshot: MwsdStatusSnapshot, now: number): {node: MwsNode; changed: boolean} {
  const status = node.isController ? undefined : statusForNode(node.mac, snapshot, now);
  const children = node.children.map((link) => ({link, result: mergeNode(link.node, snapshot, now)}));
  const statusChanged = !sameStatus(node.mwsdStatus, status);
  const changed = statusChanged || children.some(({result}) => result.changed);

  if (!changed) {
    return {node, changed: false};
  }

  const next: MwsNode = {...node, mwsdStatus: status, parent: null, children: []};

  for (const {link, result} of children) {
    next.children.push({type: link.type, node: reparent(result.node, next, link.type)});
  }

  return {node: next, changed: true};
}

function statusForNode(mac: string, snapshot: MwsdStatusSnapshot, now: number): MwsdNodeStatus {
  if (snapshot.credState !== 'present') {
    return {state: 'offline', lastSuccessAt: null};
  }

  const status = snapshot.nodes.get(mac);

  if (status === undefined) {
    return {state: 'starting', lastSuccessAt: null};
  }

  if (status.state === 'live' && isStale(status.lastSuccessAt, now)) {
    return {...status, state: 'stale'};
  }

  return status;
}

function projectState(
  rawState: unknown,
  lastSuccessAt: number | null,
  credState: MwsdCredentialState,
  now: number,
): MwsdNodeState {
  if (credState !== 'present') {
    return 'offline';
  }

  if (rawState === 'live') {
    return lastSuccessAt === null ? 'starting' : isStale(lastSuccessAt, now) ? 'stale' : 'live';
  }

  if (rawState === 'reauthenticating') {
    return lastSuccessAt === null ? 'starting' : 'stale';
  }

  if (rawState === 'authenticating' || rawState === 'starting' || rawState === undefined) {
    return 'starting';
  }

  return 'offline';
}

function isStale(lastSuccessAt: number | null, now: number): boolean {
  return lastSuccessAt !== null && now - lastSuccessAt >= MWSD_STATUS_STALE_AFTER_MS;
}

function parseCredentialState(value: unknown): MwsdCredentialState {
  return value === 'present' || value === 'invalid' || value === 'absent' ? value : 'absent';
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

function sameStatus(left: MwsNode['mwsdStatus'], right: MwsNode['mwsdStatus']): boolean {
  return left?.state === right?.state && left?.lastSuccessAt === right?.lastSuccessAt;
}

function reparent(node: MwsNode, parent: MwsNode, type: 'wired' | 'wireless'): MwsNode {
  const next: MwsNode = {...node, parent: {type, node: parent}, children: []};

  next.children = node.children.map((link) => ({type: link.type, node: reparent(link.node, next, link.type)}));

  return next;
}
