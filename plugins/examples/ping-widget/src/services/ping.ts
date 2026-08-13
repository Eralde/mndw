import type {BackendClient} from '@mndw/sdk';

export interface Host {
  ip: string;
  name?: string;
}

export interface HostStats {
  ip: string;
  name?: string;
  lastMs: number;
  avgMs: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  lossPercent: number;
  sampleCount: number;
  updatedAt: string;
}

export interface HostUpdateBody {
  action: 'add' | 'update' | 'remove';
  ip: string;
  name?: string;
}

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
}

type ApiPayload<T> = Envelope<T> | T;

async function parseEnvelope<T>(response: Response): Promise<ApiPayload<T>> {
  const text = await response.text();
  let payload: ApiPayload<T>;

  try {
    payload = JSON.parse(text) as ApiPayload<T>;
  } catch {
    throw new Error('Backend returned non-JSON response');
  }

  const envelope = !Array.isArray(payload) && typeof payload === 'object' && payload !== null
    ? payload
    : undefined;

  if (!response.ok || envelope?.success === false) {
    throw new Error(envelope?.message ?? envelope?.error ?? `Request failed with ${response.status}`);
  }

  return payload;
}

function dataArray<T>(payload: ApiPayload<T[]>): T[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  return Array.isArray(payload.data) ? payload.data : [];
}

export async function fetchStats(backend: BackendClient): Promise<HostStats[]> {
  return dataArray(await parseEnvelope<HostStats[]>(await backend.fetch('stats')));
}

export async function fetchHosts(backend: BackendClient): Promise<Host[]> {
  return dataArray(await parseEnvelope<Host[]>(await backend.fetch('hosts')));
}

export async function updateHosts(backend: BackendClient, body: HostUpdateBody): Promise<Host[]> {
  return dataArray(await parseEnvelope<Host[]>(await backend.fetch('hostsUpdate', {body})));
}
