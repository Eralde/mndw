import {
  MGMT_APPROVE_URL,
  MGMT_DELETE_URL,
  MGMT_DENY_URL,
  MGMT_DISABLE_URL,
  MGMT_ENABLE_URL,
  MGMT_LIST_URL,
  MGMT_UPLOAD_URL,
} from '../constants.js';
import type {PluginListEntry} from '../runtime/plugin-types.js';

export interface UploadResult {
  status: 'installed' | 'pending';
  entry: PluginListEntry;
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
  denyPlugin(name: string): Promise<void>;
  deletePlugin(name: string): Promise<void>;
}

interface Envelope {
  error?: {code?: string; message?: string; detail?: string};
}

async function toError(response: Response): Promise<MgmtError> {
  const body = (await response.json().catch(() => null)) as Envelope | null;
  const error = body?.error;

  return new MgmtError(error?.message ?? response.statusText, error?.code ?? 'UNKNOWN', error?.detail);
}

export function createMgmtClient(fetchImpl: typeof globalThis.fetch = globalThis.fetch): MgmtClient {
  async function postName(url: string, name: string): Promise<Response> {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name}),
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
      const response = await fetchImpl(MGMT_LIST_URL, {method: 'GET'});

      if (!response.ok) {
        throw await toError(response);
      }

      const body = (await response.json()) as {plugins: PluginListEntry[]};

      return body.plugins;
    },

    async uploadPlugin(file: File): Promise<UploadResult> {
      const response = await fetchImpl(MGMT_UPLOAD_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/zip'},
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

    async denyPlugin(name: string): Promise<void> {
      await postName(MGMT_DENY_URL, name);
    },

    async deletePlugin(name: string): Promise<void> {
      await postName(MGMT_DELETE_URL, name);
    },
  };
}

export const mgmtClient: MgmtClient = createMgmtClient();

const MESSAGES: Record<string, string> = {
  INVALID_ZIP: 'The file is not a valid ZIP archive.',
  MANIFEST_MISSING: 'The archive has no manifest.json at its root.',
  CONFLICT: 'A plugin with that name already exists.',
  UPLOAD_TOO_LARGE: 'The plugin exceeds the 10 MB upload limit.',
  OPKG_FAILED: 'Installing the plugin\'s system packages failed.',
  DAEMON_FAILED: 'Starting the plugin\'s backend failed.',
  UNAUTHORIZED: 'Your session has expired. Please log in again.',
};

export function messageForError(error: unknown): string {
  if (error instanceof MgmtError) {
    if (error.code === 'MANIFEST_INVALID') {
      return error.detail ? `Invalid manifest: ${error.detail}` : 'The plugin manifest is invalid.';
    }

    const message = MESSAGES[error.code] ?? error.message;

    return message || 'Something went wrong.';
  }

  return error instanceof Error ? error.message : 'Something went wrong.';
}
