import type {PaletteTokenMap, Switchports} from '@mndw/sdk';
import type {PluginPermission} from '@mndw/sdk-internal';
import {
  API_TIMEOUT_MS,
  MGMT_APPROVE_URL,
  MGMT_DELETE_URL,
  MGMT_DENY_URL,
  MGMT_DEVICE_HARDWARE_URL,
  MGMT_DISABLE_URL,
  MGMT_ENABLE_URL,
  MGMT_INSTALL_TIMEOUT_MS,
  MGMT_LIST_URL,
  MGMT_MUTATION_TIMEOUT_MS,
  MGMT_PALETTE_URL,
  MGMT_PERMISSION_URL,
  MGMT_RESTART_URL,
  MGMT_RUNTIME_URL,
  MGMT_TELEMETRY_URL,
  MGMT_UPLOAD_URL,
} from '../constants.js';
import {decodeMgmtList, decodeMgmtListEntry} from '../runtime/mgmt-list-schema.js';
import {decodeDeviceHardware, emptySwitchports} from '../runtime/device-info-schema.js';
import type {PluginListEntry} from '../runtime/plugin-types.js';
import {hostT} from './locale.service.js';
import {decodeErrorEnvelope, readErrorBody} from './error-envelope.js';
import {isNonEmptyString} from './json.js';

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
  public readonly detail: unknown;

  constructor(message: string, code: string, detail?: unknown) {
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
  getDeviceHardware(): Promise<{switchports: Switchports; usbPortCount: number}>;
  getPalette(): Promise<PaletteTokenMap | null>;
  putPalette(palette: PaletteTokenMap): Promise<void>;
  deletePalette(): Promise<void>;
  getTelemetry(): Promise<{enabled: boolean}>;
  setTelemetry(enabled: boolean): Promise<void>;
}

export type MgmtTimeoutKind = 'read' | 'mutation' | 'install';
export type MutationOutcome = 'ok' | 'ambiguous' | 'rejected-maintenance' | 'error';

function timeoutMs(kind: MgmtTimeoutKind): number {
  switch (kind) {
    case 'read':
      return API_TIMEOUT_MS;
    case 'mutation':
      return MGMT_MUTATION_TIMEOUT_MS;
    case 'install':
      return MGMT_INSTALL_TIMEOUT_MS;
  }
}

async function toError(response: Response): Promise<MgmtError> {
  const fields = decodeErrorEnvelope(await readErrorBody(response), response.statusText);

  return new MgmtError(fields.message, fields.code, fields.detail);
}

const csrfHeaders = (headers: HeadersInit = {}): Headers => {
  const result = new Headers(headers);

  result.set('X-Mndw-Csrf', '1');

  return result;
};

export function classifyMutationFailure(error: unknown): MutationOutcome {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'ambiguous';
  }

  if (error instanceof TypeError) {
    return 'ambiguous';
  }

  if (error instanceof MgmtError && error.code === 'BACKEND_MAINTENANCE') {
    return 'rejected-maintenance';
  }

  return 'error';
}

export function createMgmtClient(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  makeSignal: (kind: MgmtTimeoutKind) => AbortSignal = (kind) => AbortSignal.timeout(timeoutMs(kind)),
): MgmtClient {
  function timeout(kind: MgmtTimeoutKind): AbortSignal {
    return makeSignal(kind);
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

  async function postName(url: string, name: string, kind: MgmtTimeoutKind): Promise<Response> {
    const response = await fetchImpl(
      url,
      {
        method: 'POST',
        headers: csrfHeaders({'Content-Type': 'application/json'}),
        body: JSON.stringify({name}),
        signal: timeout(kind),
      },
    );

    if (!response.ok) {
      throw await toError(response);
    }

    return response;
  }

  async function mutateEntry(url: string, name: string): Promise<PluginListEntry> {
    const response = await postName(url, name, url === MGMT_APPROVE_URL ? 'install' : 'mutation');

    return decodeMgmtListEntry(await response.json());
  }

  return {
    async listPlugins(): Promise<PluginListEntry[]> {
      const response = await fetchImpl(MGMT_LIST_URL, {method: 'GET', signal: timeout('read')});

      if (!response.ok) {
        throw await toError(response);
      }

      return decodeMgmtList(await response.json());
    },

    async uploadPlugin(file: File): Promise<UploadResult> {
      // Deliberately unbounded: a 10 MB plugin over a slow link legitimately outlives
      // API_TIMEOUT_MS, and aborting a partial upload would be a regression.
      const response = await fetchImpl(
        MGMT_UPLOAD_URL,
        {
          method: 'POST',
          headers: csrfHeaders({'Content-Type': 'application/zip'}),
          body: file,
        },
      );

      if (response.status === 201 || response.status === 202) {
        const entry = decodeMgmtListEntry(await response.json());

        return {status: response.status === 201 ? 'installed' : 'pending', entry};
      }

      throw await toError(response);
    },

    approvePlugin: (name) => mutateEntry(MGMT_APPROVE_URL, name),
    enablePlugin: (name) => mutateEntry(MGMT_ENABLE_URL, name),
    disablePlugin: (name) => mutateEntry(MGMT_DISABLE_URL, name),

    async setPluginPermission(name: string, permission: PluginPermission, enabled: boolean): Promise<PluginListEntry> {
      const response = await fetchImpl(
        MGMT_PERMISSION_URL,
        {
          method: 'POST',
          headers: csrfHeaders({'Content-Type': 'application/json'}),
          body: JSON.stringify({name, permission, enabled}),
          signal: timeout('mutation'),
        },
      );

      if (!response.ok) {
        throw await toError(response);
      }

      return decodeMgmtListEntry(await response.json());
    },

    async denyPlugin(name: string): Promise<void> {
      await postName(MGMT_DENY_URL, name, 'mutation');
    },

    async deletePlugin(name: string): Promise<void> {
      await postName(MGMT_DELETE_URL, name, 'mutation');
    },

    async restartPlugin(name: string): Promise<void> {
      await postName(MGMT_RESTART_URL, name, 'mutation');
    },

    async getRuntime(): Promise<RuntimeLimits> {
      const response = await fetchImpl(
        MGMT_RUNTIME_URL,
        {method: 'GET', signal: timeout('read')},
      );

      if (!response.ok) {
        throw await toError(response);
      }

      return (await response.json()) as RuntimeLimits;
    },

    async getDeviceHardware(): Promise<{switchports: Switchports; usbPortCount: number}> {
      try {
        const response = await fetchImpl(
          MGMT_DEVICE_HARDWARE_URL,
          {
            method: 'GET',
            signal: timeout('read'),
          },
        );

        if (!response.ok) {
          return {switchports: emptySwitchports(), usbPortCount: 0};
        }

        return decodeDeviceHardware(await response.json());
      } catch {
        return {switchports: emptySwitchports(), usbPortCount: 0};
      }
    },

    async getPalette(): Promise<PaletteTokenMap | null> {
      const response = await fetchImpl(
        MGMT_PALETTE_URL,
        {
          method: 'GET',
          cache: 'no-store',
          signal: timeout('read'),
        },
      );

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
      const response = await fetchImpl(
        MGMT_PALETTE_URL,
        {
          method: 'PUT',
          headers: csrfHeaders({'Content-Type': 'application/json'}),
          body: JSON.stringify(palette),
          signal: timeout('mutation'),
        },
      );

      await expectNoContent(response);
    },

    async deletePalette(): Promise<void> {
      const response = await fetchImpl(
        MGMT_PALETTE_URL,
        {
          method: 'DELETE',
          headers: csrfHeaders(),
          signal: timeout('mutation'),
        },
      );

      await expectNoContent(response);
    },

    async getTelemetry(): Promise<{enabled: boolean}> {
      const response = await fetchImpl(MGMT_TELEMETRY_URL, {method: 'GET', signal: timeout('read')});

      if (!response.ok) {
        throw await toError(response);
      }

      const body: unknown = await response.json();

      if (body === null || typeof body !== 'object' || typeof (body as {enabled?: unknown}).enabled !== 'boolean') {
        throw new MgmtError('The device returned an unexpected telemetry response.', 'UNKNOWN');
      }

      return {enabled: (body as {enabled: boolean}).enabled};
    },

    async setTelemetry(enabled: boolean): Promise<void> {
      const response = await fetchImpl(MGMT_TELEMETRY_URL, {
        method: 'PUT',
        headers: csrfHeaders({'Content-Type': 'application/json'}),
        body: JSON.stringify({enabled}),
        signal: timeout('mutation'),
      });

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
      return isNonEmptyString(error.detail)
        ? `${hostT('errors.invalid-manifest')}: ${error.detail}`
        : hostT('errors.invalid-manifest');
    }

    const message = MESSAGE_KEYS[error.code] === undefined
      ? error.message
      : hostT(MESSAGE_KEYS[error.code]);

    return message || hostT('app.error');
  }

  return error instanceof Error ? error.message : hostT('app.error');
}
