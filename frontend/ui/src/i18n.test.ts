import {afterEach, describe, expect, it, vi} from 'vitest';
import enCatalog from './i18n/en.json';
import {getMndwUiText, setMndwUiLocale, subscribeMndwUiLocale} from './i18n.js';

afterEach(() => {
  setMndwUiLocale('en');
});

describe('mndw UI locale store', () => {
  it('stores catalog messages in nested sections', () => {
    const catalog = enCatalog as unknown as {select?: {placeholder?: string}};

    expect(catalog.select?.placeholder).toBe('Select…');
  });

  it('resolves exact and language-only catalog matches before English fallback', () => {
    setMndwUiLocale('ru-RU');
    expect(getMndwUiText('select.placeholder')).toBe('Выберите…');

    setMndwUiLocale('de-DE');
    expect(getMndwUiText('select.placeholder')).toBe('Select…');
  });

  it('normalizes pseudo locale to English explicitly', () => {
    setMndwUiLocale('en-XA');
    expect(getMndwUiText('select.placeholder')).toBe('Select…');
  });

  it('notifies subscribers and supports unsubscription', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMndwUiLocale(listener);

    setMndwUiLocale('ru');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setMndwUiLocale('en');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps setter contract to one locale argument', () => {
    expect(setMndwUiLocale.length).toBe(1);
  });
});
