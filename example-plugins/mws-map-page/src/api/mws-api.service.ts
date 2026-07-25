import {Injectable, inject} from '@angular/core';
import {type Observable, map} from 'rxjs';
import {RCI_MANAGER} from '../tokens';
import type {BridgeInterfaceRecord, DeviceHostRecord, MwsMemberRecord, ShowVersionRecord} from './rci.types';
import {MwsApiParseError, normalizeBridge, normalizeDeviceHosts, normalizeMembers, normalizeVersion} from './normalize';

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

@Injectable()
export class MwsApiService {
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
}

export {MwsApiParseError};
