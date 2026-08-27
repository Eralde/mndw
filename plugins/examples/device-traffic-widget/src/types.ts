import type {RrdTick} from '@mndw/sdk/rrd';

export interface HostClient {
  mac: string;
  name: string;
  hostname: string;
  active: boolean;
}

export interface HostBarAttribute {
  attribute: string;
  data: RrdTick[];
}

export interface HostBar {
  mac: string;
  bars: HostBarAttribute[];
}

export interface ChartResponse {
  bar: HostBar[];
}
