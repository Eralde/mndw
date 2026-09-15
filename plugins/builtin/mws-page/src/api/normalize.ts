import type {
  BridgeInterfaceRecord,
  DeviceHostRecord,
  FwUpdateSandbox,
  MwsMemberBackhaul,
  MwsMemberPort,
  MwsMemberRecord,
  MwsMemberSystem,
  RawBridgeInterface,
  RawDeviceHost,
  RawMwsMember,
  RawMwsMemberBackhaul,
  RawMwsMemberPort,
  RawShowVersion,
  ShowVersionRecord,
} from './rci.types';

export class MwsApiParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MwsApiParseError';
  }
}

const MAC_SUFFIX_RE = /((?:[0-9a-f]{2}:){5}[0-9a-f]{2})$/;
const MAC_RE = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;

export function normalizeMac(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (!MAC_RE.test(normalized)) {
    throw new MwsApiParseError(`invalid MAC: ${value}`);
  }

  return normalized;
}

export function parentMacFromBridge(bridge: string): string | null {
  const match = MAC_SUFFIX_RE.exec(bridge.trim().toLowerCase());

  return match ? match[1] : null;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function toFiniteNumber(value: unknown): number | null {
  const candidate = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

function normalizeSystem(raw: RawMwsMember['system']): MwsMemberSystem | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  const memoryMatch = /^(\d+)\/(\d+)$/.exec(raw.memory ?? '');

  return {
    cpuload: toFiniteNumber(raw.cpuload),
    memoryUsed: memoryMatch ? Number(memoryMatch[1]) : null,
    memoryTotal: memoryMatch ? Number(memoryMatch[2]) : null,
    uptime: toFiniteNumber(raw.uptime),
  };
}

function normalizeBackhaul(raw: RawMwsMemberBackhaul | undefined): MwsMemberBackhaul | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  const bridge = toNonEmptyString(raw.bridge);
  const duplex = typeof raw.duplex === 'boolean' ? (raw.duplex ? 'full' : 'half') : toNonEmptyString(raw.duplex);

  return {
    uplink: toNonEmptyString(raw.uplink),
    bridge,
    parentMac: bridge === null ? null : parentMacFromBridge(bridge),
    ap: toNonEmptyString(raw.ap),
    rssi: toFiniteNumber(raw.rssi),
    txrate: toFiniteNumber(raw.txrate),
    mode: toNonEmptyString(raw.mode),
    security: toNonEmptyString(raw.security),
    cost: toFiniteNumber(raw.cost),
    speed: toNonEmptyString(raw.speed),
    duplex,
    portLabel: toNonEmptyString(raw['port-label']),
  };
}

function normalizePorts(raw: RawMwsMemberPort[] | undefined): MwsMemberPort[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.map((port, index) => {
    const duplex = typeof port.duplex === 'boolean'
      ? (port.duplex ? 'full' : 'half')
      : toNonEmptyString(port.duplex);

    return {
      index,
      label: toNonEmptyString(port.label) ?? `Port ${index}`,
      appearance: toNonEmptyString(port.appearance),
      link: toNonEmptyString(port.link),
      speed: toNonEmptyString(port.speed),
      duplex,
    };
  });
}

function normalizeSandboxes(raw: RawMwsMember['fw-update-sandboxes']): FwUpdateSandbox[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is {version: string; name: string} =>
      typeof entry?.version === 'string' && typeof entry?.name === 'string'
    )
    .map((entry) => ({version: entry.version, name: entry.name}));
}

export function normalizeMembers(raw: unknown): MwsMemberRecord[] {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === 0) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new MwsApiParseError('show.mws.member: expected an array');
  }

  return raw.map((entry: RawMwsMember, index) => {
    const cid = toNonEmptyString(entry?.cid);
    const mac = toNonEmptyString(entry?.mac);

    if (cid === null || mac === null) {
      throw new MwsApiParseError(`show.mws.member[${index}]: cid and mac are required`);
    }

    return {
      cid,
      mac: normalizeMac(mac),
      model: toNonEmptyString(entry.model),
      knownHost: toNonEmptyString(entry['known-host']),
      ip: toNonEmptyString(entry.ip),
      fw: toNonEmptyString(entry.fw),
      fwAvailable: toNonEmptyString(entry['fw-available']),
      system: normalizeSystem(entry.system),
      backhaul: normalizeBackhaul(entry.backhaul),
      dualBand: entry.capabilities?.['dual-band'] === true,
      hwId: toNonEmptyString(entry['hw-id'] ?? entry.hw_id),
      mode: toNonEmptyString(entry.mode),
      region: toNonEmptyString(entry.region),
      ports: normalizePorts(entry.port),
      fwUpdateAvailable: entry['fw-update-available'] === true,
      fwUpdateSandboxes: normalizeSandboxes(entry['fw-update-sandboxes']),
      wirelessBands: Array.isArray(entry.wireless?.band)
        ? entry.wireless.band
          .map((band) => typeof band === 'string' ? band : toNonEmptyString(band.index))
          .filter((band): band is string => band !== null)
        : [],
    };
  });
}

export function normalizeDeviceHosts(raw: unknown): DeviceHostRecord[] {
  const hosts = (raw as {host?: unknown} | null)?.host;

  if (!Array.isArray(hosts)) {
    throw new MwsApiParseError('show.device-list: expected a host array');
  }

  const kept = hosts.filter((host: RawDeviceHost) =>
    host?.['system-mode'] !== 'extender' && host?.['mws-backhaul'] !== true && host?.active === true
  );

  return kept.map((host: RawDeviceHost, index) => {
    const mac = toNonEmptyString(host.mac);

    if (mac === null) {
      throw new MwsApiParseError(`show.device-list host[${index}]: mac is required`);
    }

    const normalizedMac = normalizeMac(mac);
    const port = host.port;
    const wired = port !== undefined && port !== null && String(port).trim() !== '';

    return {
      mac: normalizedMac,
      name: toNonEmptyString(host.name) ?? toNonEmptyString(host.hostname) ?? normalizedMac,
      ip: toNonEmptyString(host.ip),
      uptime: toFiniteNumber(host.uptime),
      lastSeen: toFiniteNumber(host['last-seen']),
      wired,
      active: host.active === true,
      mwsCid: toNonEmptyString(host.mws?.cid),
    };
  });
}

export function normalizeBridge(raw: unknown): BridgeInterfaceRecord {
  const bridge = raw as RawBridgeInterface | null;
  const mac = toNonEmptyString(bridge?.mac);

  if (mac === null) {
    throw new MwsApiParseError('show.interface Bridge0: mac is required');
  }

  return {
    mac: normalizeMac(mac),
    address: toNonEmptyString(bridge?.address),
    uptime: toFiniteNumber(bridge?.uptime),
    isOnline: bridge?.state === 'up' || bridge?.link === 'up' || bridge?.connected === 'yes',
  };
}

export function normalizeVersion(raw: unknown): ShowVersionRecord {
  const version = raw as RawShowVersion | null;

  return {
    model: toNonEmptyString(version?.model) ?? toNonEmptyString(version?.description),
    firmware: toNonEmptyString(version?.title) ?? toNonEmptyString(version?.release),
  };
}

export function normalizeControllerDescription(raw: unknown): string | null {
  const value = typeof raw === 'string'
    ? raw
    : (raw as {data?: unknown; description?: unknown} | null)?.data
      ?? (raw as {data?: unknown; description?: unknown} | null)?.description;

  const description = toNonEmptyString(value);

  return description === null ? null : description.trim();
}
