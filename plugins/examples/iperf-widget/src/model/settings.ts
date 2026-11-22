import serverData from '../data/servers.json';

export interface Server {
  id: string;
  host: string;
  portFrom: number;
  portTo: number;
  city: string;
  country: string;
}

export interface Settings {
  serverId: string;
  customHost: string;
  customPort: number;
  duration: number;
  streams: number;
}

export type SettingsErrors = Partial<Record<keyof Settings, string>>;

export interface Target {
  host: string;
  portFrom: number;
  portTo: number;
}

export const SERVERS: readonly Server[] = serverData;
export const CUSTOM_SERVER_ID = 'custom';

export const DEFAULT_SETTINGS: Settings = {
  serverId: 'spd-fisrv.hostkey.com',
  customHost: '',
  customPort: 5201,
  duration: 10,
  streams: 4,
};

function validHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253 || /\s|\/|\\|@|#|\?/.test(host)) {
    return false;
  }

  if (host.includes(':')) {
    try {
      const parsed = new URL(`http://[${host}]/`);

      return parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']');
    } catch {
      return false;
    }
  }

  const hostname = host.endsWith('.') ? host.slice(0, -1) : host;

  if (hostname.length === 0) {
    return false;
  }

  return hostname.split('.').every((label) =>
    label.length > 0
    && label.length <= 63
    && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)
  );
}

export function validateSettings(settings: Settings): SettingsErrors {
  const errors: SettingsErrors = {};

  if (!Number.isInteger(settings.duration) || settings.duration < 5 || settings.duration > 30) {
    errors.duration = 'duration';
  }

  if (!Number.isInteger(settings.streams) || settings.streams < 1 || settings.streams > 8) {
    errors.streams = 'streams';
  }

  if (settings.serverId === CUSTOM_SERVER_ID) {
    if (!validHostname(settings.customHost)) {
      errors.customHost = 'host';
    }

    if (!Number.isInteger(settings.customPort) || settings.customPort < 1 || settings.customPort > 65535) {
      errors.customPort = 'port';
    }
  } else if (!SERVERS.some((server) => server.id === settings.serverId)) {
    errors.serverId = 'server';
  }

  return errors;
}

export function resolveTarget(settings: Settings, servers: readonly Server[]): Target {
  const errors = validateSettings(settings);

  if (Object.keys(errors).length > 0) {
    throw new Error('Invalid speed test settings');
  }

  if (settings.serverId === CUSTOM_SERVER_ID) {
    return {host: settings.customHost, portFrom: settings.customPort, portTo: settings.customPort};
  }

  const server = servers.find((candidate) => candidate.id === settings.serverId);

  if (!server) {
    throw new Error(`Unknown server: ${settings.serverId}`);
  }

  return {host: server.host, portFrom: server.portFrom, portTo: server.portTo};
}
