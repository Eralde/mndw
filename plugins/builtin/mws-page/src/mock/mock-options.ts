import type {MwsMockOptions} from '../tokens';

export const DEFAULT_MOCK_EXTENDERS = 8;
export const DEFAULT_MOCK_CLIENTS = 12;
export const MAX_MOCK_EXTENDERS = 50;
export const MAX_MOCK_CLIENTS = 200;

function parseCount(value: string | null, fallback: number, maximum: number): number {
  if (value === null || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || !Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(parsed, maximum));
}

export function parseMockOptions(search: string): MwsMockOptions {
  const params = new URLSearchParams(search);

  if (params.get('mock') !== 'large') {
    return {mode: 'live', extenders: 0, clients: 0};
  }

  return {
    mode: 'large',
    extenders: parseCount(params.get('extenders'), DEFAULT_MOCK_EXTENDERS, MAX_MOCK_EXTENDERS),
    clients: parseCount(params.get('clients'), DEFAULT_MOCK_CLIENTS, MAX_MOCK_CLIENTS),
  };
}
