import type {PluginContext} from '@mndw/sdk';
import type {AcceptedOperation, DeviceTypeOverride, DeviceTypeResponse, Operation, Snapshot} from '../model/api';
import {
  decodeAcceptedOperation,
  decodeApiError,
  decodeDeviceTypeResponse,
  decodeOperation,
  decodeSnapshot,
} from '../model/decode';

export interface SmartClientApi {
  snapshot(signal?: AbortSignal): Promise<Snapshot>;
  discover(acknowledgeWake: true, signal?: AbortSignal): Promise<AcceptedOperation>;
  refresh(deviceId: string, acknowledgeWake: true, signal?: AbortSignal): Promise<AcceptedOperation>;
  operation(id: string, signal?: AbortSignal): Promise<Operation>;
  setDeviceType(
    deviceId: string,
    deviceType: DeviceTypeOverride | null,
    signal?: AbortSignal,
  ): Promise<DeviceTypeResponse>;
}

export class SmartApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string) {
    super(`SMART backend returned ${status}: ${code}`);
    this.name = 'SmartApiError';
    this.status = status;
    this.code = code;
  }
}

export class SmartClient implements SmartClientApi {
  private readonly backend: PluginContext['backend'];

  constructor(backend: PluginContext['backend']) {
    this.backend = backend;
  }

  public async snapshot(signal?: AbortSignal): Promise<Snapshot> {
    return await this.request('snapshot', undefined, undefined, signal, decodeSnapshot);
  }

  public async discover(acknowledgeWake: true, signal?: AbortSignal): Promise<AcceptedOperation> {
    return await this.request('discover', undefined, {acknowledgeWake}, signal, decodeAcceptedOperation);
  }

  public async refresh(
    deviceId: string,
    acknowledgeWake: true,
    signal?: AbortSignal,
  ): Promise<AcceptedOperation> {
    return await this.request('refresh', undefined, {deviceId, acknowledgeWake}, signal, decodeAcceptedOperation);
  }

  public async operation(id: string, signal?: AbortSignal): Promise<Operation> {
    return await this.request('operation', {id}, undefined, signal, decodeOperation);
  }

  public async setDeviceType(
    deviceId: string,
    deviceType: DeviceTypeOverride | null,
    signal?: AbortSignal,
  ): Promise<DeviceTypeResponse> {
    return await this.request('device-type', undefined, {deviceId, deviceType}, signal, decodeDeviceTypeResponse);
  }

  private async request<T>(
    route: string,
    query: Record<string, string> | undefined,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    decode: (value: unknown) => T,
  ): Promise<T> {
    const response = await this.backend.fetch(route, {query, body, signal});
    const payload: unknown = await response.json();

    if (!response.ok) {
      const error = decodeApiError(payload);

      throw new SmartApiError(response.status, error.error.code);
    }

    return decode(payload);
  }
}
