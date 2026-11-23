import type {PluginRciManager} from '@mndw/sdk';
import {parsePortDescriptions} from './parse-port-data.js';
import {portDescriptionWriteQueries, portDescriptionsQuery} from './queries.js';
import {isRecord} from './value.js';

export const MAX_DESCRIPTION_LENGTH = 64;

export type DescriptionValidation =
  | {readonly kind: 'valid'; readonly value: string}
  | {readonly kind: 'invalid'; readonly reason: 'empty' | 'too-long'};

export function validatePortDescription(value: string): DescriptionValidation {
  const trimmed = value.trim();

  if (trimmed === '') {
    return {kind: 'invalid', reason: 'empty'};
  }

  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    return {kind: 'invalid', reason: 'too-long'};
  }

  return {kind: 'valid', value: trimmed};
}

function messageFromStatus(status: Record<string, unknown>): string {
  for (const key of ['message', 'error', 'msg', 'description']) {
    const value = status[key];

    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return 'Router rejected the port name.';
}

export function throwForRciStatusError(reply: unknown): void {
  if (Array.isArray(reply)) {
    for (const entry of reply) {
      throwForRciStatusError(entry);
    }

    return;
  }

  if (!isRecord(reply)) {
    return;
  }

  if (reply.status === 'error') {
    throw new Error(messageFromStatus(reply));
  }

  if (Array.isArray(reply.status)) {
    for (const status of reply.status) {
      if (isRecord(status) && status.status === 'error') {
        throw new Error(messageFromStatus(status));
      }
    }
  }
}

export async function readPortDescriptions(rci: PluginRciManager): Promise<Record<string, string>> {
  const reply: unknown = await rci.query([portDescriptionsQuery()]);

  throwForRciStatusError(reply);

  return parsePortDescriptions(Array.isArray(reply) ? reply[0] : reply);
}

export async function writePortDescription(
  rci: PluginRciManager,
  interfaceId: string,
  description: string | null,
): Promise<void> {
  const reply: unknown = await rci.query(portDescriptionWriteQueries(interfaceId, description));

  throwForRciStatusError(reply);
}
