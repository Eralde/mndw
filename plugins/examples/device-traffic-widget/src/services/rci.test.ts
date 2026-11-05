import type {PluginRciManager} from '@mndw/sdk';
import {of} from 'rxjs';
import type {RciQuery} from '@rci-tools/core';
import {describe, expect, it} from 'vitest';
import {RciService} from './rci.js';

/** A fake PluginRciManager whose queue() dispatches on the query so getChartData's three
 *  per-attribute calls each get distinct canned data. */
function fakeRci(handler: (q: RciQuery) => unknown): PluginRciManager {
  return {queue: (q: RciQuery) => of(handler(q))} as unknown as PluginRciManager;
}

describe('RciService.getHosts', () => {
  it('maps device-list rows to HostClient with name/hostname/mac fallbacks', async () => {
    const queries: RciQuery[] = [];
    const svc = new RciService(fakeRci((query) => {
      queries.push(query);

      return {
        host: [
          {mac: 'AA', hostname: 'pc', active: true},
          {mac: 'BB', name: 'Phone', hostname: '', active: false},
          {mac: 'CC'},
        ],
      };
    }));

    const hosts = await svc.getHosts();

    expect(queries).toEqual([{path: 'show.device-list', extractData: true}]);
    expect(hosts).toEqual([
      {mac: 'AA', name: 'pc', hostname: 'pc', active: true},
      {mac: 'BB', name: 'Phone', hostname: '', active: false},
      {mac: 'CC', name: 'CC', hostname: '', active: false},
    ]);
  });

  it('returns [] when the response has no host array', async () => {
    const svc = new RciService(fakeRci(() => ({})));

    expect(await svc.getHosts()).toEqual([]);
  });
});

describe('RciService.getChartData', () => {
  it('merges tx/rx/sum bars per mac into one HostBar', async () => {
    const svc = new RciService(fakeRci((q) => {
      const attr = (q.data as {attributes: string}).attributes;

      return {bar: [{mac: 'AA', bars: [{attribute: attr, data: [{t: 1, v: 10}]}]}]};
    }));

    const result = await svc.getChartData(['AA'], 0);

    expect(result.bar).toHaveLength(1);
    expect(result.bar[0].mac).toBe('AA');
    expect(result.bar[0].bars.map((b) => b.attribute).sort())
      .toEqual(['rxspeed', 'sumspeed', 'txspeed']);
  });
});
