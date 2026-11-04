import {get} from 'svelte/store';
import {Observable} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {createTestI18n} from '../testing/i18n.js';
import {createTranslator} from './create-translator.js';

describe('createTranslator', () => {
  it('publishes a translator snapshot after locale changes', () => {
    const i18n = createTestI18n({message: 'Hello'}, 'en');
    const store = createTranslator(i18n);
    const values: string[] = [];
    const unsubscribe = store.subscribe((translator) => {
      values.push(`${translator.locale}:${translator.t('message')}`);
    });

    i18n.setLocale('ru', {message: 'Привет'});

    expect(values).toEqual(['en:Hello', 'ru:Привет']);
    expect(get(store).formatNumber(1234.5)).toBe(i18n.formatNumber(1234.5));
    unsubscribe();
  });

  it('registers lazily and removes the host callback after the last unsubscribe', () => {
    const source = createTestI18n({message: 'Hello'});
    const subscribe = vi.fn();
    const change$ = new Observable<void>((subscriber) => {
      subscribe();

      const subscription = source.change$.subscribe(subscriber);

      return () => subscription.unsubscribe();
    });
    const i18n = {...source, change$};
    const store = createTranslator(i18n);

    expect(subscribe).not.toHaveBeenCalled();

    const first = store.subscribe(() => {});
    const second = store.subscribe(() => {});

    expect(subscribe).toHaveBeenCalledTimes(1);
    first();
    expect(subscribe).toHaveBeenCalledTimes(1);
    second();
  });
});
