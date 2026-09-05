import {normalizeMac} from './normalize';
import type {MwsPortRole} from './mws-rci-write';

export const PRIMARY_SEGMENT_ID = 'Bridge0';

export interface NodeEditSegment {
  id: string;
  label: string;
}

export interface NodeEditPortRole {
  port: number;
  role: MwsPortRole;
}

export interface NodeEditState {
  staticIpEnabled: boolean;
  staticIp: string | null;
  updateChannel: string | null;
  portRoles: NodeEditPortRole[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

interface InterfaceEntry {
  id: string;
  source: Record<string, unknown>;
}

function interfaceEntries(raw: unknown): InterfaceEntry[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((value) => {
      const source = record(value);
      const id = nonEmptyString(source.id);

      return id === null ? [] : [{id, source}];
    });
  }

  const source = record(raw);
  const directId = nonEmptyString(source.id);

  if (directId !== null || source.type !== undefined || source.iseg !== undefined || source.role !== undefined) {
    return directId === null ? [] : [{id: directId, source}];
  }

  if (source.interface !== undefined) {
    return interfaceEntries(source.interface);
  }

  return Object.entries(source).flatMap(([key, value]) => {
    const entry = record(value);
    const id = nonEmptyString(entry.id) ?? nonEmptyString(key);

    return id === null ? [] : [{id, source: entry}];
  });
}

function isSegmentInterface(source: Record<string, unknown>): boolean {
  return typeof source.iseg === 'object' && source.iseg !== null && !Array.isArray(source.iseg);
}

export function normalizeBridgeSegments(interfaceRaw: unknown, showInterfaceRaw: unknown): NodeEditSegment[] {
  const segmentIds = new Set(
    interfaceEntries(interfaceRaw)
      .filter(({source}) => isSegmentInterface(source))
      .map(({id}) => id),
  );
  const seen = new Set<string>();
  const segments: NodeEditSegment[] = [];

  for (const {id, source} of interfaceEntries(showInterfaceRaw)) {
    if (source.type !== 'Bridge' || !segmentIds.has(id) || seen.has(id)) {
      continue;
    }

    const description = source.description;
    const label = nonEmptyString(description) ?? id;

    seen.add(id);
    segments.push({id, label});
  }

  return segments;
}

function memberConfig(raw: unknown, mac: string): Record<string, unknown> {
  const source = record(raw);
  const normalized = mac.toLowerCase();
  const direct = source[mac] ?? source[normalized];

  if (direct !== undefined) {
    return record(direct);
  }

  const directMember = record(source.member);
  const directMemberId = directMember.mac ?? directMember.member;

  if (typeof directMemberId === 'string' && directMemberId.toLowerCase() === normalized) {
    return directMember;
  }

  const entries = Array.isArray(raw) ? raw : Array.isArray(source.member) ? source.member : [];

  if (entries.length > 0) {
    const match = entries.find((entry) => {
      const candidate = record(entry).mac ?? record(entry).member;

      return typeof candidate === 'string' && candidate.toLowerCase() === normalized;
    });

    return record(match);
  }

  return {};
}

function parseStaticIp(raw: unknown, mac: string): string | null {
  const hosts = record(raw).host;
  const hostRecord = record(hosts);
  const entries = Array.isArray(raw)
    ? raw
    : Array.isArray(hosts)
    ? hosts
    : typeof hostRecord.mac === 'string'
    ? [hostRecord]
    : Object.values(hostRecord);
  const match = entries.find((entry) => {
    const candidate = record(entry).mac;

    return typeof candidate === 'string' && candidate.toLowerCase() === mac.toLowerCase();
  });
  const ip = record(match).ip;

  return typeof ip === 'string' && ip.trim() !== '' ? ip : null;
}

function parsePortRoles(raw: unknown): NodeEditPortRole[] {
  const source = record(raw);
  const entries = Array.isArray(source.port)
    ? source.port.map((entry, index) => {
      const port = record(entry).port;

      return [typeof port === 'string' || typeof port === 'number' ? String(port) : String(index), entry] as const;
    })
    : Object.entries(record(source.port));

  return entries
    .map(([port, value]) => {
      if (!/^\d+$/.test(port)) {
        return null;
      }

      const config = record(value);

      const disable = record(config.disable);

      if (
        config.disable === true
        || (typeof config.disable === 'object' && config.disable !== null && disable.no !== true)
      ) {
        return {port: Number(port), role: 'disabled' as const};
      }

      const access = record(config.access);

      if (access.interface === PRIMARY_SEGMENT_ID) {
        return {port: Number(port), role: 'primary' as const};
      }

      if (typeof access.interface === 'string' && access.interface.trim() !== '') {
        return {port: Number(port), role: {segment: access.interface}};
      }

      return {port: Number(port), role: 'primary' as const};
    })
    .filter((entry): entry is NodeEditPortRole => entry !== null)
    .sort((left, right) => left.port - right.port);
}

export function parseNodeEditState(dhcpRaw: unknown, memberRaw: unknown, mac: string): NodeEditState {
  const normalizedMac = normalizeMac(mac);
  const member = memberConfig(memberRaw, normalizedMac);
  const update = record(member.update);
  const channel = update.channel;

  return {
    staticIp: parseStaticIp(dhcpRaw, normalizedMac),
    staticIpEnabled: parseStaticIp(dhcpRaw, normalizedMac) !== null,
    updateChannel: typeof channel === 'string' && channel.trim() !== '' ? channel : null,
    portRoles: parsePortRoles(member),
  };
}
