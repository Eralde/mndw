import type {MndwChartPoint} from '@mndw/ui';
import type {Phase} from '../services/test-client.js';

export interface RunView {
  readonly labels: Readonly<LayoutLabels>;
  readonly phase: Phase | null;
  readonly phaseLabel: string;
  readonly currentValue: string;
  readonly speed: number;
  readonly results: Readonly<{
    download: string;
    upload: string;
    ping: string;
    jitter: string;
    summary: string;
  }>;
  readonly pingSamples: readonly (number | null)[];
  readonly pingPoints: readonly MndwChartPoint[];
  readonly pingDomain: Readonly<{min: number; max: number}>;
  readonly downloadSeries: readonly MndwChartPoint[];
  readonly uploadSeries: readonly MndwChartPoint[];
  readonly running: boolean;
  readonly statusText: string;
}

export interface LayoutLabels {
  readonly start: string;
  readonly stop: string;
  readonly download: string;
  readonly upload: string;
  readonly ping: string;
  readonly jitter: string;
  readonly chartEmpty: string;
  readonly chartSeconds: string;
  readonly chartSpeed: string;
}
