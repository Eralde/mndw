export interface MndwChartPoint {
  time: number;
  value: number;
}

export type MndwChartColor = 'accent' | 'success' | 'warning' | 'muted';

export interface MndwChartSeries {
  id: string;
  label?: string;
  data: readonly MndwChartPoint[];
  color: MndwChartColor;
  fill?: boolean;
}

export interface MndwChartDomain {
  start: number;
  end: number;
}
