import type {PaletteTokenMap, PluginPermission} from '@mndw/sdk';
import {
  API_TIMEOUT_MS,
  MGMT_APPROVE_URL,
  MGMT_DELETE_URL,
  MGMT_DENY_URL,
  MGMT_DISABLE_URL,
  MGMT_ENABLE_URL,
  MGMT_LIST_URL,
  MGMT_PALETTE_URL,
  MGMT_PERMISSION_URL,
  MGMT_RESTART_URL,
  MGMT_RUNTIME_URL,
  MGMT_UPLOAD_URL,
} from '../constants.js';
import type {PluginListEntry} from '../runtime/plugin-types.js';
import {hostT} from './locale.service.js';

export interface UploadResult {
  status: 'installed' | 'pending';
  entry: PluginListEntry;
}

export interface RuntimeLimits {
  maxConcurrentExecTotal: number;
  maxConcurrentExecPerPlugin: number;
  maxSupervisedServices: number;
  currentExec: number;
  reservedServices: number;
  supportedServiceProtocols: number[];
}

export class MgmtError extends Error {
  public readonly code: string;
  public readonly detail?: string;

  constructor(message: string, code: string, detail?: string) {
    super(message);
    this.name = 'MgmtError';
    this.code = code;
    this.detail = detail;
  }
}

export interface MgmtClient {
  listPlugins(): Promise<PluginListEntry[]>;
  uploadPlugin(file: File): Promise<UploadResult>;
  approvePlugin(name: string): Promise<PluginListEntry>;
  enablePlugin(name: string): Promise<PluginListEntry>;
  disablePlugin(name: string): Promise<PluginListEntry>;
  setPluginPermission(name: string, permission: PluginPermission, enabled: boolean): Promise<PluginListEntry>;
  denyPlugin(name: string): Promise<void>;
  deletePlugin(name: string): Promise<void>;
  restartPlugin(name: string): Promise<void>;
  getRuntime(): Promise<RuntimeLimits>;
  getPalette(): Promise<PaletteTokenMap | null>;
  putPalette(palette: PaletteTokenMap): Promise<void>;
  deletePalette(): Promise<void>;
}

interface Envelope {
  error?: {code?: string; message?: string; detail?: string};
}

async function toError(response: Response): Promise<MgmtError> {
  const body = (await response.json().catch(() => null)) as Envelope | null;
  const error = body?.error;

  return new MgmtError(error?.message ?? response.statusText, error?.code ?? 'UNKNOWN', error?.detail);
}

const csrfHeaders = (headers: HeadersInit = {}): Headers => {
  const result = new Headers(headers);

  result.set('X-Mndw-Csrf', '1');

  return result;
};

export function createMgmtClient(fetchImpl: typeof globalThis.fetch = globalThis.fetch): MgmtClient {
  function timeout(): AbortSignal {
    return AbortSignal.timeout(API_TIMEOUT_MS);
  }

  async function expectNoContent(response: Response): Promise<void> {
    if (response.status === 204) {
      return;
    }

    if (!response.ok) {
      throw await toError(response);
    }

    throw new MgmtError('The device returned an unexpected response.', 'UNKNOWN');
  }

  async function postName(url: string, name: string): Promise<Response> {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: csrfHeaders({'Content-Type': 'application/json'}),
      body: JSON.stringify({name}),
      signal: timeout(),
    });

    if (!response.ok) {
      throw await toError(response);
    }

    return response;
  }

  async function mutateEntry(url: string, name: string): Promise<PluginListEntry> {
    const response = await postName(url, name);

    return (await response.json()) as PluginListEntry;
  }

  return {
    async listPlugins(): Promise<PluginListEntry[]> {
      const response = await fetchImpl(MGMT_LIST_URL, {method: 'GET', signal: timeout()});

      if (!response.ok) {
        throw await toError(response);
      }

      const body = (await response.json()) as {plugins: PluginListEntry[]};

      return body.plugins;
    },

    async uploadPlugin(file: File): Promise<UploadResult> {
      // Deliberately unbounded: a 10 MB plugin over a slow link legitimately outlives
      // API_TIMEOUT_MS, and aborting a partial upload would be a regression.
      const response = await fetchImpl(MGMT_UPLOAD_URL, {
        method: 'POST',
        headers: csrfHeaders({'Content-Type': 'application/zip'}),
        body: file,
      });

      if (response.status === 201 || response.status === 202) {
        const entry = (await response.json()) as PluginListEntry;

        return {status: response.status === 201 ? 'installed' : 'pending', entry};
      }

      throw await toError(response);
    },

    approvePlugin: (name) => mutateEntry(MGMT_APPROVE_URL, name),
    enablePlugin: (name) => mutateEntry(MGMT_ENABLE_URL, name),
    disablePlugin: (name) => mutateEntry(MGMT_DISABLE_URL, name),
    async setPluginPermission(name: string, permission: PluginPermission, enabled: boolean): Promise<PluginListEntry> {
      const response = await fetchImpl(MGMT_PERMISSION_URL, {
        method: 'POST',
        headers: csrfHeaders({'Content-Type': 'application/json'}),
        body: JSON.stringify({name, permission, enabled}),
        signal: timeout(),
      });

      if (!response.ok) {
        throw await toError(response);
      }

      return (await response.json()) as PluginListEntry;
    },

    async denyPlugin(name: string): Promise<void> {
      await postName(MGMT_DENY_URL, name);
    },

    async deletePlugin(name: string): Promise<void> {
      await postName(MGMT_DELETE_URL, name);
    },

    async restartPlugin(name: string): Promise<void> {
      await postName(MGMT_RESTART_URL, name);
    },

    async getRuntime(): Promise<RuntimeLimits> {
      const response = await fetchImpl(MGMT_RUNTIME_URL, {method: 'GET', signal: timeout()});

      if (!response.ok) {
        throw await toError(response);
      }

      return (await response.json()) as RuntimeLimits;
    },

    async getPalette(): Promise<PaletteTokenMap | null> {
      const response = await fetchImpl(MGMT_PALETTE_URL, {
        method: 'GET',
        cache: 'no-store',
        signal: timeout(),
      });

      if (!response.ok) {
        throw await toError(response);
      }

      const body: unknown = await response.json().catch(() => null);

      if (
        body === null
        || typeof body !== 'object'
        || Array.isArray(body)
        || !Object.prototype.hasOwnProperty.call(body, 'palette')
      ) {
        throw new MgmtError('The device returned an unexpected palette response.', 'UNKNOWN');
      }

      return (body as {palette?: PaletteTokenMap | null}).palette ?? null;
    },

    async putPalette(palette: PaletteTokenMap): Promise<void> {
      const response = await fetchImpl(MGMT_PALETTE_URL, {
        method: 'PUT',
        headers: csrfHeaders({'Content-Type': 'application/json'}),
        body: JSON.stringify(palette),
        signal: timeout(),
      });

      await expectNoContent(response);
    },

    async deletePalette(): Promise<void> {
      const response = await fetchImpl(MGMT_PALETTE_URL, {method: 'DELETE', headers: csrfHeaders(), signal: timeout()});

      await expectNoContent(response);
    },
  };
}

export const mgmtClient: MgmtClient = createMgmtClient();

const MESSAGE_KEYS: Record<string, string> = {
  INVALID_ZIP: 'errors.invalid-zip',
  MANIFEST_MISSING: 'errors.manifest-missing',
  UNSUPPORTED_MANIFEST_VERSION: 'errors.unsupported-manifest-version',
  CONFLICT: 'errors.conflict',
  UPLOAD_TOO_LARGE: 'errors.upload-too-large',
  OPKG_FAILED: 'errors.opkg-failed',
  DAEMON_FAILED: 'errors.daemon-failed',
  UNAUTHORIZED: 'errors.unauthorized',
  SERVICE_CAPACITY_EXCEEDED: 'errors.service-capacity',
  BACKEND_BUSY: 'errors.backend-busy',
  BACKEND_UNAVAILABLE: 'errors.backend-unavailable',
  BACKEND_INCOMPATIBLE: 'errors.backend-incompatible',
  BACKEND_MAINTENANCE: 'errors.backend-maintenance',
  CONTROLLER_SESSION_UNAVAILABLE: 'errors.controller-session-unavailable',
  RCI_SOCKET_START_FAILED: 'errors.rci-socket-start-failed',
};

export function messageForError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return hostT('errors.device-timeout');
  }

  if (error instanceof MgmtError) {
    if (error.code === 'MANIFEST_INVALID') {
      return error.detail ? `${hostT('errors.invalid-manifest')}: ${error.detail}` : hostT('errors.invalid-manifest');
    }

    const message = MESSAGE_KEYS[error.code] === undefined
      ? error.message
      : hostT(MESSAGE_KEYS[error.code]);

    return message || hostT('app.error');
  }

  return error instanceof Error ? error.message : hostT('app.error');
}
