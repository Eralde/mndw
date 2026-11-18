import {describe, expect, it, vi} from 'vitest';
import {createTestI18n} from './testing/i18n.js';
import {bindLocale} from './bind-locale.js';

describe('bindLocale', () => {
  it('renders for the current and next locales, then stops after teardown', () => {
    const source = createTestI18n({message: 'Hello'}, 'en');
    const render = vi.fn();
    const teardown = bindLocale(source, render);

    expect(render).toHaveBeenCalledTimes(1);
    source.setLocale('ru', {message: 'Привет'});
    expect(render).toHaveBeenCalledTimes(2);

    teardown();
    source.setLocale('en', {message: 'Hello again'});
    expect(render).toHaveBeenCalledTimes(2);
  });
});
