import {type TelemetryClient, createTelemetryClient} from '@mndw/sdk';

export type TelemetryService = TelemetryClient;

export function createTelemetryService(fetchImpl: typeof globalThis.fetch = globalThis.fetch): TelemetryService {
  return createTelemetryClient(fetchImpl);
}

export const telemetryService: TelemetryService = createTelemetryService();
