export interface MndwChartSample {
  readonly value: number;
  readonly time?: number;
}

export type MndwChartValueFormatter = (value: number) => string;
export type MndwChartTimeFormatter = (epochMs: number) => string;

export interface MndwChartPresentationProps {
  emptyLabel?: string;
  valueLabel?: string;
  valueFormatter?: MndwChartValueFormatter;
  timeFormatter?: MndwChartTimeFormatter;
}

export interface MndwLineChartProps extends MndwChartPresentationProps {
  series?: readonly MndwChartSeries[];
  domain?: MndwChartDomain;
}

export interface MndwBarChartProps extends MndwChartPresentationProps {
  points?: readonly MndwChartPoint[];
  color?: MndwChartColor;
}

export interface MndwSparklineProps extends MndwChartPresentationProps {
  points?: readonly MndwChartSample[];
  max?: number;
  color?: MndwChartColor;
}

export interface MndwHeatStripProps extends MndwChartPresentationProps {
  points?: readonly MndwChartSample[];
  max?: number;
}

export interface MndwChartPoint {
  readonly time: number;
  readonly value: number;
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
