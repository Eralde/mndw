import {Injectable, inject} from '@angular/core';
import type {BackendClient} from '@mndw/sdk';
import {type RciManager, type RciQuery, RciResponseHelper} from '@rci-tools/core';
import {firstValueFrom} from 'rxjs';
import {
  type MwsPortRole,
  buildSetAutoApShutdownQueries,
  buildSetAutoUpdateQueries,
  buildSetAutoUpdateScheduleQueries,
  buildSetBackhaulQueries,
  buildSetNameQueries,
  buildSetPortRoleQueries,
  buildSetStaticIpQueries,
  buildSetUpdateChannelQueries,
} from '../api/mws-rci-write';
import {validateNodeName} from '../api/node-name';
import {MWSD_BACKEND, RCI_MANAGER} from '../tokens';
import {MwsDataService} from './mws-data.service';

export interface MwsWriteStatus {
  readonly status: string;
  readonly code: string;
  readonly ident: string;
  readonly message: string;
}

export interface MwsWriteStep {
  readonly step: string;
  readonly ok: boolean;
  readonly status: MwsWriteStatus[];
}

export interface MwsWriteResult {
  readonly ok: boolean;
  readonly steps: MwsWriteStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectRciStatuses(value: unknown, statuses: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectRciStatuses(entry, statuses));

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (typeof value.status === 'string') {
    statuses.push(value);

    return;
  }

  if (Array.isArray(value.status)) {
    value.status.forEach((entry) => collectRciStatuses(entry, statuses));
  } else if (isRecord(value.status)) {
    Object.values(value.status).forEach((entry) => collectRciStatuses(entry, statuses));
  }

  Object.entries(value).forEach(([key, entry]) => {
    if (key !== 'status') {
      collectRciStatuses(entry, statuses);
    }
  });
}

function normalizeRciStatus(response: unknown): MwsWriteStatus[] | null {
  const statuses: Record<string, unknown>[] = [];

  collectRciStatuses(response, statuses);

  if (statuses.length === 0) {
    return null;
  }

  return statuses.map((entry) => {
    return {
      status: typeof entry.status === 'string' ? entry.status : '',
      code: typeof entry.code === 'string' || typeof entry.code === 'number' ? String(entry.code) : '',
      ident: typeof entry.ident === 'string' ? entry.ident : '',
      message: typeof entry.message === 'string' ? entry.message : '',
    };
  });
}

@Injectable()
export class MwsWriteService {
  private readonly backend: BackendClient | null = inject(MWSD_BACKEND);
  private readonly rci: RciManager = inject(RCI_MANAGER);
  private readonly data = inject(MwsDataService);

  public async setName(mac: string, name: string | null): Promise<MwsWriteResult> {
    if (name === null) {
      return this.executeRciWrite(buildSetNameQueries(mac, null), ['set-name', 'save']);
    }

    const validation = validateNodeName(name);

    if (validation.value === null) {
      throw new Error(validation.error ?? 'Invalid name.');
    }

    return this.executeRciWrite(buildSetNameQueries(mac, validation.value), ['set-name', 'save']);
  }

  public async setStaticIP(mac: string, ip?: string): Promise<MwsWriteResult> {
    return this.executeRciWrite(buildSetStaticIpQueries(mac, ip ?? null), ['set-static-ip', 'save']);
  }

  public async setUpdateChannel(mac: string, channel?: string): Promise<MwsWriteResult> {
    return this.executeRciWrite(buildSetUpdateChannelQueries(mac, channel ?? null), ['set-update-channel', 'save']);
  }

  public async setPortRole(
    mac: string,
    port: string,
    previousRole: MwsPortRole,
    nextRole: MwsPortRole,
  ): Promise<MwsWriteResult> {
    const queries = buildSetPortRoleQueries(mac, port, previousRole, nextRole);

    if (queries.length === 0) {
      return {ok: true, steps: []};
    }

    const stepNames = queries.map((query, index) =>
      index === queries.length - 1 ? 'save' : this.portStepName(query, index)
    );

    return this.executeRciWrite(queries, stepNames);
  }

  public async setBackhaul(enabled: boolean): Promise<MwsWriteResult> {
    return this.executeRciWrite(buildSetBackhaulQueries(enabled), ['set-backhaul', 'save']);
  }

  public async setAutoApShutdown(enabled: boolean): Promise<MwsWriteResult> {
    return this.executeRciWrite(buildSetAutoApShutdownQueries(enabled), ['set-auto-ap-shutdown', 'save']);
  }

  public async setAutoUpdate(enabled: boolean): Promise<MwsWriteResult> {
    return this.executeRciWrite(buildSetAutoUpdateQueries(enabled), ['set-auto-update', 'save']);
  }

  public async setAutoUpdateSchedule(schedule: string | null): Promise<MwsWriteResult> {
    return this.executeRciWrite(buildSetAutoUpdateScheduleQueries(schedule), ['set-auto-update-schedule', 'save']);
  }

  public async setPower(
    nodeId: string,
    interfaceName: 'WifiMaster0' | 'WifiMaster1',
    power: number,
    persist = true,
  ): Promise<MwsWriteResult> {
    if (this.data.extraFeaturesAvailability() !== 'active') {
      throw new Error('mws-page extra features are unavailable');
    }

    if (this.backend === null) {
      throw new Error('mws-page write backend is unavailable');
    }

    const response = await this.backend.fetch('write', {
      body: {
        operation: 'wifi.set-power',
        nodeId,
        params: {interface: interfaceName, power, persist},
      },
    });

    if (!response.ok) {
      throw new Error(`mws-page write failed with HTTP ${response.status}`);
    }

    return await response.json() as MwsWriteResult;
  }

  private async executeRciWrite(queries: RciQuery[], stepNames: string[]): Promise<MwsWriteResult> {
    const response = await firstValueFrom(this.rci.queue(queries));
    const responses = Array.isArray(response) ? response : [response];
    const steps = stepNames.map((step, index) => {
      const stepResponse = responses[index];
      const status = normalizeRciStatus(stepResponse);

      return {
        step,
        ok: status !== null && !RciResponseHelper.hasErrors(stepResponse ?? {}),
        status: status ?? [],
      };
    });

    return {ok: steps.every((step) => step.ok), steps};
  }

  private portStepName(query: RciQuery, index: number): string {
    const port = ((query.data as {port?: unknown} | undefined)?.port ?? {}) as Record<string, unknown>;
    const access = port.access as Record<string, unknown> | undefined;

    if (port.disable !== undefined) {
      return (port.disable as Record<string, unknown> | undefined)?.no === true
        ? 'clear-port-disabled'
        : 'set-port-disabled';
    }

    if (access?.interface !== undefined) {
      return 'set-port-segment';
    }

    if (access?.no === true) {
      return 'clear-port-access';
    }

    return `set-port-${index + 1}`;
  }
}
