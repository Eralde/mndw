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

  it('accepts nested catalogs and replaces locale/catalog before emitting locale$', () => {
    const i18n = createTestI18n({message: {hello: 'Hello'}}, 'en');
    const observed: string[] = [];

    i18n.locale$.subscribe((locale) => {
      observed.push(`${locale}:${i18n.t('message.hello')}`);
    });
    i18n.setLocale('ru', {message: {hello: 'Привет'}});

    expect(observed).toEqual(['en:Hello', 'ru:Привет']);
    expect(i18n.t('message.hello')).toBe('Привет');
  });

  it('emits the current locale synchronously and supports subscription teardown', () => {
    const i18n = createTestI18n({message: 'Hello'});
    const callback = vi.fn();
    const subscription = i18n.locale$.subscribe(callback);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenLastCalledWith('en');

    i18n.setLocale('ru', {message: 'Привет'});
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith('ru');

    subscription.unsubscribe();
    i18n.setLocale('en', {message: 'Hello again'});
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('formats numbers and dates using the committed locale', () => {
    const i18n = createTestI18n({}, 'en-XA');

    expect(i18n.formatNumber(1234.5)).toBe(new Intl.NumberFormat('en').format(1234.5));
    expect(i18n.formatDate(new Date('2024-01-02T00:00:00.000Z'), {timeZone: 'UTC'})).toBe(
      new Intl.DateTimeFormat('en', {timeZone: 'UTC'}).format(new Date('2024-01-02T00:00:00.000Z')),
    );
  });
});
