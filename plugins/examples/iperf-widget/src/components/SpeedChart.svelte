<script lang="ts">
import type {MndwChartSeries} from '@mndw/ui';
import {formatBitRate} from '../model/format.js';

interface Props {
  download: readonly {time: number; value: number}[];
  upload: readonly {time: number; value: number}[];
  downloadLabel: string;
  uploadLabel: string;
  emptyLabel: string;
  secondsUnit: string;
  valueLabel: string;
  locale: string;
}

let {download, upload, downloadLabel, uploadLabel, emptyLabel, secondsUnit,
  valueLabel, locale}: Props = $props();
const series = $derived.by((): readonly MndwChartSeries[] => [
  {id: 'download', label: downloadLabel, color: 'accent', data: download},
  {id: 'upload', label: uploadLabel, color: 'success', data: upload},
]);

function formatSpeed(value: number): string {
  return formatBitRate(value, locale);
}

function formatSeconds(value: number): string {
  return `${new Intl.NumberFormat(locale).format(value)} ${secondsUnit}`;
}
</script>

<mndw-line-chart
  {series}
  valueTicks={2}
  valueAxis={true}
  valueFormatter={formatSpeed}
  timeFormatter={formatSeconds}
  {valueLabel}
  {emptyLabel}
></mndw-line-chart>

<style>
mndw-line-chart {
  display: block;
  inline-size: 100%;
  block-size: 100%;
  min-block-size: 0;
}

mndw-line-chart::part(empty) {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}
</style>
