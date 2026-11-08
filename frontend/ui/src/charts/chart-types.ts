export interface MndwChartSample {
  readonly value: number;
  readonly time?: number;
}

export type MndwChartValueFormatter = (value: number) => string;
export type MndwChartTimeFormatter = (epochMs: number) => string;

export interface MndwChartTooltipSample {
  readonly seriesId: string;
  readonly label: string;
  readonly value: number;
  readonly time: number;
}

export interface MndwChartTooltipContext {
  readonly time: number;
  readonly samples: readonly MndwChartTooltipSample[];
}

export interface MndwChartTooltipContent {
  readonly title?: string;
  readonly rows: readonly {readonly label: string; readonly value: string}[];
}

export type MndwChartTooltipFormatter = (context: MndwChartTooltipContext) => MndwChartTooltipContent | null;

export interface MndwChartPresentationProps {
  emptyLabel?: string;
  valueLabel?: string;
  valueFormatter?: MndwChartValueFormatter;
  timeFormatter?: MndwChartTimeFormatter;
}

export interface MndwLineChartProps extends MndwChartPresentationProps {
  series?: readonly MndwChartSeries[];
  bands?: readonly MndwChartBand[];
  domain?: MndwChartDomain;
  valueDomain?: MndwChartValueDomain;
  tooltipFormatter?: MndwChartTooltipFormatter;
}

export interface MndwBarChartProps extends MndwChartPresentationProps {
  points?: readonly MndwChartPoint[];
  valueDomain?: MndwChartValueDomain;
  color?: MndwChartColor;
  tooltipFormatter?: MndwChartTooltipFormatter;
}

export interface MndwSparklineProps extends MndwChartPresentationProps {
  points?: readonly MndwChartSample[];
  timeDomain?: MndwChartDomain;
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
  segments?: readonly MndwChartSegment[];
}

export interface MndwChartSegment {
  readonly data: readonly MndwChartPoint[];
}

export interface MndwChartBandPoint {
  readonly time: number;
  readonly min: number;
  readonly max: number;
}

export interface MndwChartBand {
  readonly id: string;
  readonly data: readonly MndwChartBandPoint[];
  readonly color: MndwChartColor;
}

export interface MndwChartDomain {
  start: number;
  end: number;
}

export interface MndwChartValueDomain {
  readonly min: number;
  readonly max: number;
}
