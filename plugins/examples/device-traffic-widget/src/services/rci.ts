import type {PluginRciManager, RciQuery} from '@mndw/sdk';
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
  public constructor(private rci: PluginRciManager) {}

  public async getHosts(): Promise<HostClient[]> {
    const query: RciQuery = {
      path: 'show.device-list',
      extractData: true,
    };
    const response = await this.rci.query(query);

    return (response.host || []).map((h: any) => ({
      mac: h.mac,
      name: h.name || h.hostname || h.mac,
      hostname: h.hostname || '',
      active: h.active || false,
    }));
  }

  private async getChartAttribute(
    items: string[],
    detail: number,
    attribute: string,
    signal?: AbortSignal,
  ): Promise<ChartResponse> {
    const query: RciQuery = {
      path: 'show.ip.hotspot.chart',
      data: {attributes: attribute, detail, items: items.join(',')},
      extractData: true,
    };

    return await this.rci.query(query, signal === undefined ? undefined : {signal});
  }

  public async getChartData(items: string[], detail: number, signal?: AbortSignal): Promise<ChartResponse> {
    const [tx, rx, sum] = await Promise.all([
      this.getChartAttribute(items, detail, 'txspeed', signal),
      this.getChartAttribute(items, detail, 'rxspeed', signal),
      this.getChartAttribute(items, detail, 'sumspeed', signal),
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

  public async getDeviceTime(signal?: AbortSignal): Promise<ClockDate> {
    const query: RciQuery = {path: 'show.clock.date', extractData: true};

    return await this.rci.query(query, signal === undefined ? undefined : {signal});
  }
}
