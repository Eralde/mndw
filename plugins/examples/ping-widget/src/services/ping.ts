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

function parseEnvelope<T>(payload: ApiPayload<T>): ApiPayload<T> {
  const envelope = !Array.isArray(payload) && typeof payload === 'object' && payload !== null
    ? payload
    : undefined;

  if (envelope?.success === false) {
    throw new Error(envelope.message ?? envelope.error ?? 'Backend request failed');
  }

  return payload;
}

function dataArray<T>(payload: ApiPayload<T[]>): T[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  return Array.isArray(payload.data) ? payload.data : [];
}

export async function fetchStats(backend: BackendClient, signal?: AbortSignal): Promise<HostStats[]> {
  return dataArray(parseEnvelope(await backend.call<ApiPayload<HostStats[]>>('stats', {as: 'json', signal})));
}

export async function fetchHosts(backend: BackendClient): Promise<Host[]> {
  return dataArray(parseEnvelope(await backend.call<ApiPayload<Host[]>>('hosts', {as: 'json'})));
}

export async function updateHosts(backend: BackendClient, body: HostUpdateBody): Promise<Host[]> {
  return dataArray(parseEnvelope(await backend.call<ApiPayload<Host[]>>('hostsUpdate', {as: 'json', body})));
}
