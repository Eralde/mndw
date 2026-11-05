import type {PluginRciManager} from '@mndw/sdk';
import {TestBed} from '@angular/core/testing';
import type {RciQuery} from '@rci-tools/core';
import {firstValueFrom, of} from 'rxjs';
import {afterEach, describe, expect, it} from 'vitest';

import {RCI_MANAGER} from '../tokens.js';
import {RciService} from './rci.service.js';

function fakeRci(handler: (query: RciQuery | RciQuery[]) => unknown): PluginRciManager {
  return {queue: (query: RciQuery | RciQuery[]) => of(handler(query))} as unknown as PluginRciManager;
}

function service(handler: (query: RciQuery | RciQuery[]) => unknown): RciService {
  TestBed.configureTestingModule({providers: [{provide: RCI_MANAGER, useValue: fakeRci(handler)}]});

  return TestBed.inject(RciService);
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('RciService.getInterfaceRrd', () => {
  it('maps a batched [tx, rx] response into {tx, rx} data arrays', async () => {
    const svc = service((query) => {
      const attribute = ((query as RciQuery[])[0].data as {attribute: string}).attribute;

      void attribute;

      return [{data: [{t: 1, v: 10}]}, {data: [{t: 1, v: 20}]}];
    });

    const result = await firstValueFrom(svc.getInterfaceRrd('eth0'));

    expect(result.tx).toEqual([{t: 1, v: 10}]);
    expect(result.rx).toEqual([{t: 1, v: 20}]);
  });

  it('falls back to empty arrays when data is absent', async () => {
    const svc = service(() => [{}, {}]);
    const result = await firstValueFrom(svc.getInterfaceRrd('eth0'));

    expect(result).toEqual({tx: [], rx: []});
  });
});
