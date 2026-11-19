import {setMndwUiLocale} from '@mndw/ui';
import {SvelteSet} from 'svelte/reactivity';
import {formatMessage, normalizeFormatterLocale} from '@mndw/sdk-internal/i18n-format';
import enCatalog from '../i18n/en.json';
import ruCatalog from '../i18n/ru.json';
import {STORAGE_PREFIX, SUPPORTED_LOCALES} from '../constants.js';
import {type CatalogNode, pseudoLocalizeCatalog} from './pseudo-locale.js';
import type {PluginCatalogService} from './plugin-catalog.service.js';

type HostCatalog = Record<string, CatalogNode>;
type LocaleListener = (locale: string) => void;

const LOCALE_STORAGE_KEY = `${STORAGE_PREFIX}:locale`;
const HOST_CATALOGS: Record<string, HostCatalog> = {
  en: enCatalog as HostCatalog,
  ru: ruCatalog as HostCatalog,
};
const PSEUDO_HOST_CATALOG = pseudoLocalizeCatalog(enCatalog);

function canonicalize(locale: string): string | undefined {
  try {
    if (typeof Intl.getCanonicalLocales === 'function') {
      return Intl.getCanonicalLocales(locale)[0];
    }

    if (typeof Intl.Locale === 'function') {
      return new Intl.Locale(locale).toString();
    }
  } catch {
    // Fall through to the unsupported-runtime result below.
  }

  return undefined;
}

export function isPseudoLocaleEnabled(): boolean {
  return typeof __MNDW_PSEUDO_LOCALE_ENABLED__ !== 'undefined'
    && __MNDW_PSEUDO_LOCALE_ENABLED__ === true;
}

export function getAvailableLocales(): readonly string[] {
  return isPseudoLocaleEnabled() ? [...SUPPORTED_LOCALES, 'en-XA'] : SUPPORTED_LOCALES;
}

function exactSupported(locale: string): string | undefined {
  const canonical = canonicalize(locale);

  return getAvailableLocales().find((candidate) => candidate === canonical);
}

function navigatorSupported(locale: string): string | undefined {
  const canonical = canonicalize(locale);

  if (canonical === undefined) {
    return undefined;
  }

  return exactSupported(canonical) ?? getAvailableLocales().find((candidate) => candidate === canonical.split('-')[0]);
}

function readStoredLocale(storage: Pick<Storage, 'getItem'> | undefined): string | undefined {
  try {
    return storage?.getItem(LOCALE_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function navigatorCandidates(): string[] {
  const candidates = [...navigator.languages];

  if (navigator.language !== '') {
    candidates.push(navigator.language);
  }

  return candidates;
}

export interface LocaleServiceDeps {
  catalog: Pick<
    PluginCatalogService,
    'preparePluginCatalogGeneration' | 'commitPluginCatalogGeneration'
  >;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  document?: Document;
  setUiLocale?: (locale: string) => void;
}

export interface LocaleService {
  initLocale(): string;
  getLocale(): string;
  setLocale(locale: string): Promise<void>;
  subscribeLocale(listener: LocaleListener): () => void;
  isLocaleSwitchPending(): boolean;
  subscribeLocalePending(listener: (pending: boolean) => void): () => void;
  hostT(this: void, key: string, values?: Record<string, unknown>, locale?: string): string;
  hostFormatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  hostFormatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  getAvailableLocales(): readonly string[];
  isPseudoLocaleEnabled(): boolean;
}

export function createLocaleService(deps: LocaleServiceDeps): LocaleService {
  const catalog = deps.catalog;
  const storage = deps.storage ?? globalThis.localStorage;
  const hostDocument = deps.document ?? globalThis.document;
  const setUiLocale = deps.setUiLocale ?? setMndwUiLocale;
  let currentLocale = $state<string>(SUPPORTED_LOCALES[0]);
  let localeSwitchPending = false;
  const listeners = new SvelteSet<LocaleListener>();
  const pendingListeners = new SvelteSet<(pending: boolean) => void>();

  const applyLocaleMetadata = (locale: string): void => {
    hostDocument.documentElement.lang = locale;
    hostDocument.documentElement.dir = 'ltr';
  };

  const commitLocale = (locale: string): void => {
    currentLocale = locale;
    setUiLocale(locale);
    applyLocaleMetadata(locale);

    for (const listener of listeners) {
      listener(locale);
    }
  };

  const initLocale = (): string => {
    const stored = readStoredLocale(storage);
    const persisted = stored === undefined ? undefined : exactSupported(stored);
    const next = persisted
      ?? navigatorCandidates().map(navigatorSupported)
        .find((locale): locale is string => locale !== undefined)
      ?? 'en';

    commitLocale(next);

    return next;
  };

  const setLocale = async (locale: string): Promise<void> => {
    const next = navigatorSupported(locale) ?? 'en';

    if (next === currentLocale) {
      return;
    }

    localeSwitchPending = true;

    for (const listener of pendingListeners) {
      listener(true);
    }

    const generation = catalog.preparePluginCatalogGeneration(next);

    await generation.promise;

    catalog.commitPluginCatalogGeneration(generation, () => {
      commitLocale(next);

      try {
        storage?.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        // Locale persistence is best-effort in private/embedded browser contexts.
      }
    });

    localeSwitchPending = false;

    for (const listener of pendingListeners) {
      listener(false);
    }
  };

  const subscribeLocale = (listener: LocaleListener): () => void => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  };

  const subscribeLocalePending = (listener: (pending: boolean) => void): () => void => {
    pendingListeners.add(listener);

    return () => {
      pendingListeners.delete(listener);
    };
  };

  return Object.freeze({
    initLocale,
    getLocale: () => currentLocale,
    setLocale,
    subscribeLocale,
    isLocaleSwitchPending: () => localeSwitchPending,
    subscribeLocalePending,
    hostT: (key: string, values?: Record<string, unknown>, locale?: string): string =>
      translateHostMessage(key, values, locale ?? currentLocale),
    hostFormatNumber: (value: number, options?: Intl.NumberFormatOptions): string =>
      new Intl.NumberFormat(normalizeFormatterLocale(currentLocale), options)
        .format(value),
    hostFormatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions): string =>
      new Intl.DateTimeFormat(normalizeFormatterLocale(currentLocale), options)
        .format(value),
    getAvailableLocales,
    isPseudoLocaleEnabled,
  });
}

export function translateHostMessage(key: string, values: Record<string, unknown> | undefined, locale: string): string {
  const hostCatalog = locale === 'en-XA' && isPseudoLocaleEnabled()
    ? PSEUDO_HOST_CATALOG
    : HOST_CATALOGS[locale] ?? HOST_CATALOGS.en;
  const message = catalogMessage(hostCatalog, key)
    ?? catalogMessage(HOST_CATALOGS.en, key)
    ?? key;

  if (values === undefined) {
    return message;
  }

  return formatMessage(message, values, locale);
}

function catalogMessage(catalog: HostCatalog, key: string): string | undefined {
  let value: CatalogNode | undefined = catalog;

  for (const part of key.split('.')) {
    if (typeof value === 'string') {
      return undefined;
    }

    value = value[part];
  }

  return typeof value === 'string' ? value : undefined;
}
