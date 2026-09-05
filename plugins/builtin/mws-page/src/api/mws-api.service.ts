import {Injectable, inject} from '@angular/core';
import {type Observable, catchError, firstValueFrom, map, of, throwError} from 'rxjs';
import {type MwsRenameApi, RCI_MANAGER} from '../tokens';
import {type ControllerTelemetry, parseControllerTelemetry} from './controller-telemetry';
import type {BridgeInterfaceRecord, DeviceHostRecord, MwsMemberRecord, ShowVersionRecord} from './rci.types';
import {
  normalizeBridge,
  normalizeControllerDescription,
  normalizeDeviceHosts,
  normalizeMac,
  normalizeMembers,
  normalizeVersion,
} from './normalize';
import {validateNodeName} from './node-name';
import {type TransitionLogStream, createTransitionLogStream} from './transition-log-api';

export type MwsMemberResult = {kind: 'ok'; members: MwsMemberRecord[]} | {kind: 'unsupported'};

export interface ScheduleAction {
  action: 'start' | 'stop';
  min: string;
  hour: string;
  dow: string;
}

export interface ScheduleDefinition {
  description: string;
  action: ScheduleAction[];
}

export interface SystemSettings {
  backhaulEnabled: boolean;
  autoApShutdownEnabled: boolean;
  autoUpdateEnabled: boolean;
  autoUpdateSchedule: string | null;
  schedules: Record<string, ScheduleDefinition>;
}

/** Pinned provisional signature; replace when a live non-controller capture is available. */
const UNSUPPORTED_MWS_SIGNATURES = [{code: '7405600', ident: 'Mws::MemberList'}];

export function isUnsupportedMwsMemberResponse(value: unknown): boolean {
  const status = (value as {status?: unknown} | null)?.status;

  if (!Array.isArray(status)) {
    return false;
  }

  return status.some((entry: {status?: string; code?: unknown; ident?: unknown}) =>
    entry?.status === 'error'
    && UNSUPPORTED_MWS_SIGNATURES.some(
      (signature) => String(entry.code) === signature.code && entry.ident === signature.ident,
    )
  );
}

function renameResponseError(response: unknown): Error | null {
  const status = (response as {status?: unknown} | null)?.status;

  if (!Array.isArray(status)) {
    return null;
  }

  const failed = status.find((entry: {status?: unknown}) => entry?.status === 'error') as {
    message?: unknown;
    error?: unknown;
    msg?: unknown;
    description?: unknown;
  } | undefined;

  if (failed === undefined) {
    return null;
  }

  const message = [failed.message, failed.error, failed.msg, failed.description]
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');

  return new Error(message ?? 'Device rejected node name.');
}

function responseError(response: unknown, fallback: string): Error | null {
  const error = renameResponseError(response);

  return error === null ? null : new Error(error.message || fallback);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeSchedule(value: unknown): ScheduleDefinition | null {
  const source = record(value);
  const description = typeof source.description === 'string' ? source.description : '';
  const actions = Array.isArray(source.action) ? source.action : [];
  const action = actions
    .map((entry): ScheduleAction | null => {
      const candidate = record(entry);

      if (
        (candidate.action !== 'start' && candidate.action !== 'stop')
        || typeof candidate.min !== 'string'
        || typeof candidate.hour !== 'string'
        || typeof candidate.dow !== 'string'
      ) {
        return null;
      }

      return {
        action: candidate.action,
        min: candidate.min,
        hour: candidate.hour,
        dow: candidate.dow,
      };
    })
    .filter((entry): entry is ScheduleAction => entry !== null);

  return description === '' ? null : {description, action};
}

function parseSystemSettings(responses: unknown): SystemSettings {
  const values = Array.isArray(responses) ? responses : [];
  const backhaul = record(values[0]);
  const autoApRaw = values[1];
  const autoAp = typeof autoApRaw === 'boolean' ? autoApRaw : !record(autoApRaw).no;
  const autoUpdate = record(values[2]);
  const scheduleValue = autoUpdate.schedule;
  const schedulesSource = record(values[3]);
  const schedules: Record<string, ScheduleDefinition> = {};

  for (const [id, value] of Object.entries(schedulesSource)) {
    const schedule = normalizeSchedule(value);

    if (schedule !== null) {
      schedules[id] = schedule;
    }
  }

  return {
    backhaulEnabled: backhaul.shutdown !== true,
    autoApShutdownEnabled: autoAp,
    autoUpdateEnabled: autoUpdate.disable !== true,
    autoUpdateSchedule: typeof scheduleValue === 'string' && scheduleValue.trim() !== '' ? scheduleValue : null,
    schedules,
  };
}

@Injectable()
export class MwsApiService implements MwsRenameApi {
  private readonly rci = inject(RCI_MANAGER);

  public startTransitionLogStream(names: Readonly<Record<string, string>> = {}): TransitionLogStream {
    return createTransitionLogStream(this.rci, names);
  }

  public showMwsMember(): Observable<MwsMemberResult> {
    return this.rci.queue({path: 'show.mws.member'}).pipe(
      map((response: unknown): MwsMemberResult => {
        if (isUnsupportedMwsMemberResponse(response)) {
          return {kind: 'unsupported'};
        }

        return {kind: 'ok', members: normalizeMembers(response)};
      }),
    );
  }

  public showDeviceList(): Observable<DeviceHostRecord[]> {
    return this.rci.queue({path: 'show.device-list'}).pipe(map((response) => normalizeDeviceHosts(response)));
  }

  public showBridge0(): Observable<BridgeInterfaceRecord> {
    return this.rci.queue({path: 'show.interface', data: {name: 'Bridge0'}})
      .pipe(
        map((response) => normalizeBridge(response)),
      );
  }

  public showVersion(): Observable<ShowVersionRecord> {
    return this.rci.queue({path: 'show.version'}).pipe(map((response) => normalizeVersion(response)));
  }

  /** The controller name is written at system.description but exposed by show.version.description. */
  public showControllerDescription(): Observable<string | null> {
    return this.rci.queue({path: 'show.version'}).pipe(
      map((response) => normalizeControllerDescription(response)),
    );
  }

  public showSystemSettings(): Observable<SystemSettings> {
    return this.rci.queue([
      {path: 'show.sc.mws.backhaul'},
      {path: 'show.sc.mws.auto-ap-shutdown'},
      {path: 'show.sc.components.auto-update'},
      {path: 'show.sc.schedule'},
    ]).pipe(map((responses) => parseSystemSettings(responses)));
  }

  public getAuthUrl(member: string): Promise<string> {
    const normalized = member.trim();

    if (normalized === '') {
      return Promise.reject(new Error('member is required'));
    }

    return firstValueFrom(
      this.rci.queue({path: 'mws.member.auth-url', data: {member: normalized}}).pipe(
        map((response: unknown) => {
          const error = responseError(response, 'auth-url request failed');

          if (error !== null) {
            throw error;
          }

          const url = record(response).url;

          if (typeof url !== 'string' || url.trim() === '') {
            throw new Error('device returned no auth URL');
          }

          return url;
        }),
      ),
    );
  }

  /**
   * The controller's own live utilization, fetched directly through the
   * RciManager. All queries go out as one batch (RciManager's array `queue`
   * overload), and each result comes back index-aligned — `undefined` for a query
   * with no data, so a firmware without a given radio (or the channel-utilization
   * endpoint) simply contributes no series. Only a whole-batch transport failure
   * falls back to null.
   */
  public showControllerTelemetry(): Observable<ControllerTelemetry | null> {
    const queries = [
      {path: 'show.system'},
      {path: 'show.system.rrd.cpu', data: {detail: 0, attribute: 'avg'}},
      {path: 'show.system.rrd.memory', data: {detail: 0, attribute: 'used'}},
      {path: 'show.interface.channel-utilization.chart', data: {name: 'WifiMaster0', detail: 0}},
      {path: 'show.interface.channel-utilization.chart', data: {name: 'WifiMaster1', detail: 0}},
    ];

    return this.rci.queue(queries)
      .pipe(
        map((responses) =>
          parseControllerTelemetry(responses[0], responses[1], responses[2], [
            {interface: 'WifiMaster0', chart: responses[3]},
            {interface: 'WifiMaster1', chart: responses[4]},
          ], Date.now())
        ),
        catchError(() => of<ControllerTelemetry | null>(null)),
      );
  }

  public renameNode(mac: string, isController: boolean, name: string): Observable<void> {
    const validation = validateNodeName(name);

    if (validation.value === null) {
      return throwError(() => new Error(validation.error ?? 'Invalid name.'));
    }

    let query: {path: string; data: string | {mac: string; name: string}};

    try {
      query = isController
        ? {path: 'system.description', data: validation.value}
        : {path: 'known.host', data: {mac: normalizeMac(mac), name: validation.value}};
    } catch (error) {
      return throwError(() => error);
    }

    return this.rci.queue(query)
      .pipe(
        map((response: unknown): void => {
          const error = renameResponseError(response);

          if (error !== null) {
            throw error;
          }
        }),
      );
  }
}
