import {expect, it} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import messages from '../../i18n/en.json';
import ruMessages from '../../i18n/ru.json';
import {formatAgo, timeAgo} from './ago.js';

const en = createTestI18n(messages);
const ru = createTestI18n(ruMessages, 'ru');

it('reads last-change as a duration in seconds', () => {
  expect(timeAgo(22)).toEqual({unit: 'seconds', count: 22});
  expect(timeAgo(11413.135198)).toEqual({unit: 'hours', count: 3});
});

it('picks the largest whole unit that fits', () => {
  expect(timeAgo(59.9)).toEqual({unit: 'seconds', count: 59});
  expect(timeAgo(1000)).toEqual({unit: 'minutes', count: 16});
  expect(timeAgo(300_000)).toEqual({unit: 'days', count: 3});
});

it('has no age without a duration', () => {
  expect(timeAgo(null)).toBeNull();
  expect(timeAgo(-1)).toBeNull();
});

it('formats hours and days with the en and ru plurals', () => {
  expect(formatAgo({unit: 'hours', count: 3}, en)).toBe('3 hours ago');
  expect(formatAgo({unit: 'hours', count: 3}, ru)).toBe('3 часа назад');
  expect(formatAgo({unit: 'days', count: 2}, en)).toBe('2 days ago');
  expect(formatAgo({unit: 'days', count: 2}, ru)).toBe('2 дня назад');
  expect(formatAgo({unit: 'days', count: 5}, ru)).toBe('5 дней назад');
});
