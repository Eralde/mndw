import {firstValueFrom} from 'rxjs';
import type {RciManager, RciQuery} from '@rci-tools/core';
import type {ChartResponse, HostBar, HostClient} from '../types.js';

export interface ClockDate {
  weekday: number;
  day: number;
  month: number;
  year: number;
  hour: number;
  min: number;
  sec: number;
  msec: number;
}

export class RciService {
  public constructor(private rci: RciManager) {}

  public async getHosts(): Promise<HostClient[]> {
    const query: RciQuery = {
      path: 'show.ip.hotspot',
      data: {details: 'internet-access'},
      extractData: true,
    };
    const response = await firstValueFrom(this.rci.queue(query));

    return (response.host || []).map((h: any) => ({
      mac: h.mac,
      name: h.name || h.hostname || h.mac,
      hostname: h.hostname || '',
      active: h.active || false,
    }));
  }

  private async getChartAttribute(items: string[], detail: number, attribute: string): Promise<ChartResponse> {
    const query: RciQuery = {
      path: 'show.ip.hotspot.chart',
      data: {attributes: attribute, detail, items: items.join(',')},
      extractData: true,
    };

    return await firstValueFrom(this.rci.queue(query));
  }

  public async getChartData(items: string[], detail: number): Promise<ChartResponse> {
    const [tx, rx, sum] = await Promise.all([
      this.getChartAttribute(items, detail, 'txspeed'),
      this.getChartAttribute(items, detail, 'rxspeed'),
      this.getChartAttribute(items, detail, 'sumspeed'),
    ]);

    const macMap = new Map<string, HostBar>();

    for (const response of [tx, rx, sum]) {
      for (const bar of response.bar || []) {
        let entry = macMap.get(bar.mac);

        if (!entry) {
          entry = {mac: bar.mac, bars: []};
          macMap.set(bar.mac, entry);
        }

        entry.bars.push(...bar.bars);
      }
    }

    return {bar: Array.from(macMap.values())};
  }

  public async getDeviceTime(): Promise<ClockDate> {
    const query: RciQuery = {path: 'show.clock.date', extractData: true};

    return await firstValueFrom(this.rci.queue(query));
  }
}
