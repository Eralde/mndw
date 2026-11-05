import type {TelemetryClient} from '@mndw/sdk';
import {createTelemetryClient} from '@mndw/sdk-internal';

export type TelemetryService = TelemetryClient;

export function createTelemetryService(fetchImpl: typeof globalThis.fetch = globalThis.fetch): TelemetryService {
  return createTelemetryClient(fetchImpl);
}

export const telemetryService: TelemetryService = createTelemetryService();
