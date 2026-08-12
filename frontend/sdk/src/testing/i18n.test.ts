import {describe, expect, it, vi} from 'vitest';
import {createTestI18n} from './i18n.js';

describe('createTestI18n', () => {
  it('echoes missing keys and exposes the reserved direction', () => {
    const i18n = createTestI18n({greeting: 'Hello'}, 'en');

    expect(i18n.t('greeting')).toBe('Hello');
    expect(i18n.t('missing')).toBe('missing');
    expect(i18n.locale).toBe('en');
    expect(i18n.direction).toBe('ltr');
  });

  it('accepts nested catalogs and replaces locale/catalog before notifying', () => {
    const i18n = createTestI18n({message: {hello: 'Hello'}}, 'en');
    let observed = '';

    i18n.onChange(() => {
      observed = `${i18n.locale}:${i18n.t('message.hello')}`;
    });
    i18n.setLocale('ru', {message: {hello: 'Привет'}});

    expect(observed).toBe('ru:Привет');
    expect(i18n.t('message.hello')).toBe('Привет');
  });

  it('notifies subscribers synchronously and supports teardown', () => {
    const i18n = createTestI18n({message: 'Hello'});
    const callback = vi.fn();
    const unsubscribe = i18n.onChange(callback);

    i18n.setLocale('ru', {message: 'Привет'});
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    i18n.setLocale('en', {message: 'Hello again'});
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('formats numbers and dates using the committed locale', () => {
    const i18n = createTestI18n({}, 'en-XA');

    expect(i18n.formatNumber(1234.5)).toBe(new Intl.NumberFormat('en').format(1234.5));
    expect(i18n.formatDate(new Date('2024-01-02T00:00:00.000Z'), {timeZone: 'UTC'})).toBe(
      new Intl.DateTimeFormat('en', {timeZone: 'UTC'}).format(new Date('2024-01-02T00:00:00.000Z')),
    );
  });
});
