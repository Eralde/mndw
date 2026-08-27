import {describe, expect, it, vi} from 'vitest';
import {createTestI18n} from './testing/i18n.js';
import {bindLocale} from './bind-locale.js';

describe('bindLocale', () => {
  it('renders immediately, rerenders synchronously, and returns teardown', () => {
    const i18n = createTestI18n({message: 'Hello'}, 'en');
    const render = vi.fn();
    const teardown = bindLocale(i18n, render);

    expect(render).toHaveBeenCalledTimes(1);
    i18n.setLocale('ru', {message: 'Привет'});
    expect(render).toHaveBeenCalledTimes(2);

    teardown();
    i18n.setLocale('en', {message: 'Hello again'});
    expect(render).toHaveBeenCalledTimes(2);
  });
});
