import type {RciManager} from '@rci-tools/core';
import {type Observable, map} from 'rxjs';

export const MAX_DESCRIPTION_LENGTH = 64;

export type DescriptionValidation =
  | {readonly kind: 'valid'; readonly value: string}
  | {readonly kind: 'invalid'; readonly message: string};

export interface DeviceDescriptionApi {
  read(): Observable<string>;
  write(description: string): Observable<void>;
}

export class DeviceRciStatusError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DeviceRciStatusError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusMessage(status: Record<string, unknown>): string {
  for (const key of ['message', 'error', 'msg', 'description']) {
    const value = status[key];

    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }

  return 'Device rejected description.';
}

function throwForStatusError(response: unknown): void {
  if (!isRecord(response) || !Array.isArray(response.status)) {
    return;
  }

  const status = response.status.find((entry: unknown) => isRecord(entry) && entry.status === 'error');

  if (!isRecord(status)) {
    return;
  }

  throw new DeviceRciStatusError(statusMessage(status));
}

function normalizeDescription(response: unknown): string {
  if (typeof response === 'string') {
    return response.trim();
  }

  if (!isRecord(response)) {
    return '';
  }

  const selected = response.data !== null && response.data !== undefined ? response.data : response.description;

  return typeof selected === 'string' ? selected.trim() : '';
}

export function validateDescription(value: string): DescriptionValidation {
  const trimmed = value.trim();

  if (trimmed === '') {
    return {kind: 'invalid', message: 'validation.empty'};
  }

  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    return {kind: 'invalid', message: 'validation.too-long'};
  }

  return {kind: 'valid', value: trimmed};
}

export function createDeviceDescriptionApi(rci: RciManager): DeviceDescriptionApi {
  return {
    read() {
      return rci.queue({path: 'show.version'}).pipe(
        map((response: unknown) => {
          throwForStatusError(response);

          return normalizeDescription(response);
        }),
      );
    },
    write(description: string) {
      return rci.queue({path: 'system.description', data: description}).pipe(
        map((response: unknown) => {
          throwForStatusError(response);

          return undefined;
        }),
      );
    },
  };
}
