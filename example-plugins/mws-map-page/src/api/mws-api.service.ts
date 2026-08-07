import {Injectable, inject} from '@angular/core';
import {type Observable, map, throwError} from 'rxjs';
import {type MwsRenameApi, RCI_MANAGER} from '../tokens';
import type {BridgeInterfaceRecord, DeviceHostRecord, MwsMemberRecord, ShowVersionRecord} from './rci.types';
import {
  MwsApiParseError,
  normalizeBridge,
  normalizeControllerDescription,
  normalizeDeviceHosts,
  normalizeMac,
  normalizeMembers,
  normalizeVersion,
} from './normalize';
import {validateNodeName} from './node-name';

export type MwsMemberResult = {kind: 'ok'; members: MwsMemberRecord[]} | {kind: 'unsupported'};

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

@Injectable()
export class MwsApiService implements MwsRenameApi {
  private readonly rci = inject(RCI_MANAGER);

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
    return this.rci.queue({path: 'show.interface', data: {name: 'Bridge0'}}).pipe(
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

    return this.rci.queue(query).pipe(
      map((response: unknown): void => {
        const error = renameResponseError(response);

        if (error !== null) {
          throw error;
        }
      }),
    );
  }
}

export {MwsApiParseError};
