export interface HostClient {
  mac: string;
  name: string;
  hostname: string;
  active: boolean;
}

export interface BarTick {
  t: number;
  v: number;
}

export interface HostBarAttribute {
  attribute: string;
  data: BarTick[];
}

export interface HostBar {
  mac: string;
  bars: HostBarAttribute[];
}

export interface ChartResponse {
  bar: HostBar[];
}
