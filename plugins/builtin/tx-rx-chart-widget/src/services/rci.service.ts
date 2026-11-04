import {Injectable, inject} from '@angular/core';
import {Observable, map} from 'rxjs';
import type {RciQuery} from '@rci-tools/core';
import type {RrdTick} from '@mndw/sdk/rrd';
import type {ClockDate, ShowInterfaceResponse} from '../types/rci.types';
import {RCI_MANAGER} from '../tokens';

@Injectable({providedIn: 'root'})
export class RciService {
  private readonly rci = inject(RCI_MANAGER);

  public getInterfaces(): Observable<ShowInterfaceResponse> {
    const query: RciQuery = {path: 'show.interface'};

    return this.rci.queue(query) as Observable<ShowInterfaceResponse>;
  }

  public getDeviceTime(): Observable<ClockDate> {
    const query: RciQuery = {path: 'show.clock.date'};

    return this.rci.queue(query) as Observable<ClockDate>;
  }

  public getInterfaceRrd(
    interfaceId: string,
    detail = 0,
  ): Observable<{tx: RrdTick[]; rx: RrdTick[]}> {
    const txQuery: RciQuery = {
      path: 'show.interface.rrd',
      data: {name: interfaceId, detail, attribute: 'txspeed'},
    };
    const rxQuery: RciQuery = {
      path: 'show.interface.rrd',
      data: {name: interfaceId, detail, attribute: 'rxspeed'},
    };

    return (this.rci.queue([txQuery, rxQuery]))
      .pipe(
        map(([txResponse, rxResponse]) => {
          return {
            tx: txResponse?.data ?? [],
            rx: rxResponse?.data ?? [],
          };
        }),
      );
  }
}
