import {describe, expect, it, vi} from 'vitest';
import {Subject} from 'rxjs';
import {createTestI18n} from './testing/i18n.js';
import {bindLocale} from './bind-locale.js';

describe('bindLocale', () => {
  it('renders once, re-renders on change$, stops after the returned teardown', () => {
    const source = createTestI18n({message: 'Hello'}, 'en');
    const changes = new Subject<void>();
    const i18n = {
      locale: source.locale,
      direction: source.direction,
      t: (key: string, values?: Record<string, unknown>): string => source.t(key, values),
      formatNumber: (value: number, options?: Intl.NumberFormatOptions): string => source.formatNumber(value, options),
      formatDate: (value: Date, options?: Intl.DateTimeFormatOptions): string => source.formatDate(value, options),
      change$: changes.asObservable(),
    };
    const render = vi.fn();
    const teardown = bindLocale(i18n, render);

    expect(render).toHaveBeenCalledTimes(1);
    changes.next();
    expect(render).toHaveBeenCalledTimes(2);

    teardown();
    changes.next();
    expect(render).toHaveBeenCalledTimes(2);
  });
});
