export interface RrdTick {
  t: number;
  v: number;
}

export interface NetworkInterface {
  id: string;
  description?: string;
}

export type ShowInterfaceResponse = Record<string, {
  id: string;
  description?: string;
}>;

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
