import {isRecord} from './value.js';

export type PortDescriptions = Record<string, string>;
export type HotspotDevices = Record<string, string[]>;

export function parsePortDescriptions(reply: unknown): PortDescriptions {
  if (!isRecord(reply)) {
    return {};
  }

  const root = isRecord(reply.interface) ? reply.interface : reply;
  const descriptions: PortDescriptions = {};

  for (const [interfaceId, value] of Object.entries(root)) {
    if (!isRecord(value) || typeof value.description !== 'string') {
      continue;
    }

    const description = value.description.trim();

    if (description !== '') {
      descriptions[interfaceId] = description;
    }
  }

  return descriptions;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return null;
}

export function parseHotspotDevices(reply: unknown): HotspotDevices {
  if (!isRecord(reply) || !Array.isArray(reply.host)) {
    return {};
  }

  const devices: HotspotDevices = {};

  for (const host of reply.host) {
    if (!isRecord(host) || host.active !== true) {
      continue;
    }

    const label = firstString(host.port, isRecord(host.mws) ? host.mws.port : null);
    const name = firstString(host.name, host.hostname, host.mac);

    if (label === null || name === null) {
      continue;
    }

    (devices[label] ??= []).push(name);
  }

  return devices;
}
