// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {FALLBACK_HOST_INFO, SUPPORTED_LOCALES} from '../constants.js';
import {type LocaleService, createLocaleService} from './locale.service.svelte.js';
import {createPluginCatalogService} from './plugin-catalog.service.js';

const originalLanguages = navigator.languages;
const originalLanguage = navigator.language;
let service: LocaleService;

function setNavigatorLocales(languages: string[], language = languages[0] ?? 'en-US'): void {
  Object.defineProperty(navigator, 'languages', {configurable: true, value: languages});
  Object.defineProperty(navigator, 'language', {configurable: true, value: language});
}

beforeEach(() => {
  service = createLocaleService({catalog: createPluginCatalogService()});
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

    expect(service.initLocale()).toBe('en');
    expect(service.getAvailableLocales()).toEqual(['en', 'ru']);
  });

  it('routes dev pseudo locale through the normal committed state', async () => {
    vi.stubGlobal('__MNDW_PSEUDO_LOCALE_ENABLED__', true);

    expect(service.getAvailableLocales()).toEqual(['en', 'ru', 'en-XA']);
    await service.setLocale('en-XA');

    expect(service.getLocale()).toBe('en-XA');
    expect(service.hostT('settings.title')).toMatch(/^\[/);
    expect(service.hostFormatNumber(1234.5)).toContain('1');
  });
});

describe('locale service', () => {
  it('supports isolated injected storage, document, catalog, and UI locale sink', async () => {
    const isolatedDocument = document.implementation.createHTMLDocument('isolated');
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => stored.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        stored.set(key, value);
      },
    };
    const setUiLocale = vi.fn();
    const isolatedService = createLocaleService({
      catalog: createPluginCatalogService(),
      storage,
      document: isolatedDocument,
      setUiLocale,
    });

    stored.set('mndw:locale', 'ru');

    expect(isolatedService.initLocale()).toBe('ru');
    expect(isolatedDocument.documentElement.lang).toBe('ru');
    expect(setUiLocale).toHaveBeenCalledWith('ru');

    await isolatedService.setLocale('en');

    expect(stored.get('mndw:locale')).toBe('en');
    expect(isolatedDocument.documentElement.lang).toBe('en');
    expect(document.documentElement.lang).toBe('');
  });

  it('exposes fixed production locales and a typed fallback locale', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'ru']);
    expect(FALLBACK_HOST_INFO.locale).toBe('en');
  });

  it('prefers a supported persisted locale and updates document metadata', () => {
    localStorage.setItem('mndw:locale', 'RU');

    expect(service.initLocale()).toBe('ru');
    expect(service.getLocale()).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('falls through from invalid persisted values to navigator locale then English', () => {
    localStorage.setItem('mndw:locale', 'en-XA');
    setNavigatorLocales(['ru-RU']);

    expect(service.initLocale()).toBe('ru');

    localStorage.setItem('mndw:locale', 'de');
    setNavigatorLocales(['de-DE']);
    expect(service.initLocale()).toBe('en');
  });

  it('resolves canonical navigator language-only matches and tolerates storage failures', () => {
    setNavigatorLocales(['ru-Cyrl-RU']);
    expect(service.initLocale()).toBe('ru');

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    setNavigatorLocales(['ru']);
    expect(service.initLocale()).toBe('ru');
  });

  it('translates synchronously and formats with the committed locale', async () => {
    service.initLocale();

    expect(service.hostT('settings.palette-import-aria-label')).toBe('Import palette JSON');
    expect(service.hostT('settings.backend-capacity')).toBe('Backend capacity');
    expect(service.hostT('settings.upload-plugin-zip')).toBe('Upload plugin ZIP');

    await service.setLocale('ru');

    expect(service.hostT('app.loading')).toBe('Загрузка…');
    expect(service.hostT('settings.palette-import-aria-label')).toBe('Импорт JSON-палитры');
    expect(service.hostT('settings.backend-capacity')).toBe('Ёмкость серверной части');
    expect(service.hostT('settings.upload-plugin-zip')).toBe('Загрузить ZIP плагина');
    expect(service.hostFormatNumber(1234.5)).toContain('1');
    expect(service.hostFormatNumber(1234.5)).toContain('234');
    expect(service.hostFormatDate(new Date('2026-01-02T03:04:00Z'), {timeZone: 'UTC'})).toContain('2026');
  });

  it('notifies only after locale commit and supports unsubscription', async () => {
    service.initLocale();

    const listener = vi.fn();
    const unsubscribe = service.subscribeLocale(listener);

    await service.setLocale('ru');
    expect(listener).toHaveBeenCalledWith('ru');

    unsubscribe();
    await service.setLocale('en');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not install a cross-tab storage listener', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');

    service.initLocale();

    expect(addEventListener.mock.calls.some(([type]) => type === 'storage')).toBe(false);
  });
});
