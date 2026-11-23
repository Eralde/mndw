import {expect, it} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import messages from '../../i18n/en.json';
import ruMessages from '../../i18n/ru.json';
import {formatPortSpeed, formatSpeed, speedBadge} from './speed.js';

const en = createTestI18n(messages);
const ru = createTestI18n(ruMessages, 'ru');

it('writes the compact speed badge', () => {
  expect([10, 100, 1000, 2500, 5000, 10000].map((speed) =>
    speedBadge(speed, (value, options) => {
      return en.formatNumber(value, options);
    })
  )).toEqual([
    '10M',
    '100M',
    '1G',
    '2.5G',
    '5G',
    '10G',
  ]);
});

it('follows the widget locale for the badge fraction', () => {
  expect(speedBadge(2500, (value, options) => {
    return ru.formatNumber(value, options);
  })).toBe('2,5G');
});

it('writes the full speed with the Mbps and Gbps units', () => {
  expect(formatSpeed(100, en)).toBe('100 Mbps');
  expect(formatSpeed(1000, en)).toBe('1 Gbps');
  expect(formatSpeed(2500, ru)).toBe('2,5 Гбит/с');
});

it('formats compact line speeds with a fixed gigabit decimal', () => {
  expect(formatPortSpeed(1000, en)).toBe('1.0 G');
  expect(formatPortSpeed(2500, en)).toBe('2.5 G');
  expect(formatPortSpeed(100, en)).toBe('100 M');
});
