import type {Translator} from '@mndw/sdk/svelte';

type FormatNumber = Translator['formatNumber'];
type Messages = Pick<Translator, 't' | 'formatNumber'>;

/** Compact badge text: 10M, 100M, 1G, 2.5G, 5G, 10G. */
export function speedBadge(speedMbps: number, formatNumber: FormatNumber): string {
  if (speedMbps >= 1000) {
    return `${formatNumber(speedMbps / 1000, {maximumFractionDigits: 1})}G`;
  }

  return `${formatNumber(speedMbps)}M`;
}

/** Full speed text for the accessible name and the details panel. */
export function formatSpeed(speedMbps: number, translator: Messages): string {
  if (speedMbps >= 1000) {
    return translator.t('speed.gbps', {
      value: translator.formatNumber(speedMbps / 1000, {maximumFractionDigits: 1}),
    });
  }

  return translator.t('speed.mbps', {value: translator.formatNumber(speedMbps)});
}

/** Compact value used on the port row, with a fixed decimal for gigabit links. */
export function formatPortSpeed(speedMbps: number, translator: Messages): string {
  if (speedMbps >= 1000) {
    return `${translator.formatNumber(speedMbps / 1000, {minimumFractionDigits: 1, maximumFractionDigits: 1})} G`;
  }

  return `${translator.formatNumber(speedMbps)} M`;
}
