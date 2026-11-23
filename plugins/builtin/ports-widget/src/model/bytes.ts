import type {Translator} from '@mndw/sdk/svelte';

type Messages = Pick<Translator, 't' | 'formatNumber'>;

const UNITS = ['b', 'kb', 'mb', 'gb', 'tb'] as const;
const BIT_UNITS = ['bit', 'kbit', 'mbit', 'gbit', 'tbit'] as const;

export type ByteUnit = (typeof UNITS)[number];
export type BitUnit = (typeof BIT_UNITS)[number];

export interface ScaledBytes {
  readonly value: number;
  readonly unit: ByteUnit;
}

export interface ScaledBits {
  readonly value: number;
  readonly unit: BitUnit;
}

function scaled<T extends string>(amount: number, units: readonly T[]): {value: number; unit: T} {
  let value = Math.max(amount, 0);
  let index = 0;

  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }

  return {value, unit: units[index]};
}

function digitOptions(value: number): Intl.NumberFormatOptions {
  return {maximumFractionDigits: value < 10 ? 1 : 0};
}

/** Decimal steps are the convention for network counters. */
export function scaleBytes(bytes: number): ScaledBytes {
  return scaled(bytes, UNITS);
}

/** Bit rates use the same decimal steps as the link speed. */
export function scaleBits(bits: number): ScaledBits {
  return scaled(bits, BIT_UNITS);
}

export function formatBytes(bytes: number, translator: Messages): string {
  const {value, unit} = scaleBytes(bytes);

  return translator.t('bytes', {
    value: translator.formatNumber(value, digitOptions(value)),
    unit: translator.t(`unit.${unit}`),
  });
}

export function formatBitRate(bitsPerSecond: number, translator: Messages): string {
  const {value, unit} = scaleBits(bitsPerSecond);

  return translator.t('rate', {
    value: translator.formatNumber(value, digitOptions(value)),
    unit: translator.t(`unit.${unit}`),
  });
}
