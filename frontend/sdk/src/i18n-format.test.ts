import {describe, expect, it} from 'vitest';
import {formatMessage, normalizeFormatterLocale} from './i18n-format.js';

describe('i18n formatting', () => {
  it('returns plain messages without invoking ICU formatting', () => {
    expect(formatMessage('Hello', undefined, 'en')).toBe('Hello');
  });

  it('formats interpolation, plural, and select messages', () => {
    expect(formatMessage('Hello, {name}!', {name: 'Ada'}, 'en')).toBe('Hello, Ada!');
    expect(formatMessage('{count, plural, one {# item} other {# items}}', {count: 2}, 'en')).toBe('2 items');
    expect(formatMessage('{kind, select, warning {Warning} other {Info}}', {kind: 'warning'}, 'en')).toBe('Warning');
  });

  it('returns the original message when ICU parsing fails', () => {
    const message = '{count, plural, one {# item}';

    expect(formatMessage(message, {count: 1}, 'en')).toBe(message);
  });

  it('coerces formatter output to a string', () => {
    expect(formatMessage('Value: {value}', {value: 42}, 'en')).toBe('Value: 42');
  });

  it('normalizes pseudo locale for formatter calls', () => {
    expect(normalizeFormatterLocale('en-XA')).toBe('en');
    expect(normalizeFormatterLocale('ru')).toBe('ru');
    expect(formatMessage('Hello, {name}!', {name: 'Ada'}, 'en-XA')).toBe('Hello, Ada!');
  });
});
