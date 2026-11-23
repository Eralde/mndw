import {expect, it} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import messages from '../../i18n/en.json';
import ruMessages from '../../i18n/ru.json';
import {formatBitRate, formatBytes, scaleBits, scaleBytes} from './bytes.js';

const en = createTestI18n(messages);
const ru = createTestI18n(ruMessages, 'ru');

it('scales byte totals in decimal steps', () => {
  expect(scaleBytes(0)).toEqual({value: 0, unit: 'b'});
  expect(scaleBytes(1500)).toEqual({value: 1.5, unit: 'kb'});
  expect(scaleBytes(2_500_000)).toEqual({value: 2.5, unit: 'mb'});
});

it('formats totals in bytes', () => {
  expect(formatBytes(0, en)).toBe('0 B');
  expect(formatBytes(1500, en)).toBe('1.5 KB');
});

it('scales rates in decimal bits, like the link speed', () => {
  expect(scaleBits(999)).toEqual({value: 999, unit: 'bit'});
  expect(scaleBits(12_000)).toEqual({value: 12, unit: 'kbit'});
  expect(scaleBits(1_500_000)).toEqual({value: 1.5, unit: 'mbit'});
});

it('formats rates with the widget locale', () => {
  expect(formatBitRate(12_000, en)).toBe('12 kbit/s');
  expect(formatBitRate(1_500_000, en)).toBe('1.5 Mbit/s');
  expect(formatBitRate(12_000, ru)).toBe('12 Кбит/с');
});
