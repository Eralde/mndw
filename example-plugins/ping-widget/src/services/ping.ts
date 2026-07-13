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

async function parseEnvelope<T>(response: Response): Promise<Envelope<T>> {
  const text = await response.text();
  let payload: Envelope<T>;

  try {
    payload = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new Error('Backend returned non-JSON response');
  }

  if (!response.ok || payload.success === false) {
    throw new Error(payload.message ?? payload.error ?? `Request failed with ${response.status}`);
  }

  return payload;
}

function dataArray<T>(payload: Envelope<T[]>): T[] {
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
