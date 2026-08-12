import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {FALLBACK_HOST_INFO, SUPPORTED_LOCALES} from '../constants.js';
import {
  getLocale,
  hostFormatDate,
  hostFormatNumber,
  hostT,
  initLocale,
  getAvailableLocales,
  setLocale,
  subscribeLocale,
} from './locale.service.js';

const originalLanguages = navigator.languages;
const originalLanguage = navigator.language;

function setNavigatorLocales(languages: string[], language = languages[0] ?? 'en-US'): void {
  Object.defineProperty(navigator, 'languages', {configurable: true, value: languages});
  Object.defineProperty(navigator, 'language', {configurable: true, value: language});
}

beforeEach(() => {
  localStorage.clear();
  setNavigatorLocales(['en-US']);
  document.documentElement.lang = '';
  document.documentElement.dir = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  Object.defineProperty(navigator, 'languages', {configurable: true, value: originalLanguages});
  Object.defineProperty(navigator, 'language', {configurable: true, value: originalLanguage});
});

describe('pseudo locale gating', () => {
  it('keeps en-XA out of production-mode supported locales and persisted resolution', () => {
    vi.stubGlobal('__MNDW_PSEUDO_LOCALE_ENABLED__', false);
    localStorage.setItem('mndw:locale', 'en-XA');

    expect(initLocale()).toBe('en');
    expect(getAvailableLocales()).toEqual(['en', 'ru']);
  });

  it('routes dev pseudo locale through the normal committed state', async () => {
    vi.stubGlobal('__MNDW_PSEUDO_LOCALE_ENABLED__', true);

    expect(getAvailableLocales()).toEqual(['en', 'ru', 'en-XA']);
    await setLocale('en-XA');

    expect(getLocale()).toBe('en-XA');
    expect(hostT('settings.title')).toMatch(/^\[/);
    expect(hostFormatNumber(1234.5)).toContain('1');
  });
});

describe('locale service', () => {
  it('exposes fixed production locales and a typed fallback locale', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'ru']);
    expect(FALLBACK_HOST_INFO.locale).toBe('en');
  });

  it('prefers a supported persisted locale and updates document metadata', () => {
    localStorage.setItem('mndw:locale', 'RU');

    expect(initLocale()).toBe('ru');
    expect(getLocale()).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('falls through from invalid persisted values to navigator locale then English', () => {
    localStorage.setItem('mndw:locale', 'en-XA');
    setNavigatorLocales(['ru-RU']);

    expect(initLocale()).toBe('ru');

    localStorage.setItem('mndw:locale', 'de');
    setNavigatorLocales(['de-DE']);
    expect(initLocale()).toBe('en');
  });

  it('resolves canonical navigator language-only matches and tolerates storage failures', () => {
    setNavigatorLocales(['ru-Cyrl-RU']);
    expect(initLocale()).toBe('ru');

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    setNavigatorLocales(['ru']);
    expect(initLocale()).toBe('ru');
  });

  it('translates synchronously and formats with the committed locale', async () => {
    await setLocale('ru');

    expect(hostT('app.loading')).toBe('Загрузка…');
    expect(hostFormatNumber(1234.5)).toContain('1');
    expect(hostFormatNumber(1234.5)).toContain('234');
    expect(hostFormatDate(new Date('2026-01-02T03:04:00Z'), {timeZone: 'UTC'})).toContain('2026');
  });

  it('notifies only after locale commit and supports unsubscription', async () => {
    initLocale();
    const listener = vi.fn();
    const unsubscribe = subscribeLocale(listener);

    await setLocale('ru');
    expect(listener).toHaveBeenCalledWith('ru');

    unsubscribe();
    await setLocale('en');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not install a cross-tab storage listener', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');

    initLocale();

    expect(addEventListener.mock.calls.some(([type]) => type === 'storage')).toBe(false);
  });
});
