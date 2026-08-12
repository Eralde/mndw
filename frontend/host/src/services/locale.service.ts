import {setMndwUiLocale} from '@mndw/ui';
import {formatMessage, normalizeFormatterLocale} from '@mndw/sdk/i18n-format';
import enCatalog from '../i18n/en.json';
import ruCatalog from '../i18n/ru.json';
import {STORAGE_PREFIX, SUPPORTED_LOCALES} from '../constants.js';
import {type CatalogNode, pseudoLocalizeCatalog} from './pseudo-locale.js';
import {commitPluginCatalogGeneration, preparePluginCatalogGeneration} from './plugin-catalog.service.js';

type HostCatalog = Record<string, CatalogNode>;
type LocaleListener = (locale: string) => void;

const LOCALE_STORAGE_KEY = `${STORAGE_PREFIX}:locale`;
const HOST_CATALOGS: Record<string, HostCatalog> = {
  en: enCatalog as HostCatalog,
  ru: ruCatalog as HostCatalog,
};
const PSEUDO_HOST_CATALOG = pseudoLocalizeCatalog(enCatalog);

let committedLocale: string = SUPPORTED_LOCALES[0];
let localeSwitchPending = false;
const listeners = new Set<LocaleListener>();
const pendingListeners = new Set<(pending: boolean) => void>();

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

function readStoredLocale(): string | undefined {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY) ?? undefined;
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

function applyLocaleMetadata(locale: string): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = 'ltr';
}

function commitLocale(locale: string): void {
  committedLocale = locale;
  setMndwUiLocale(locale);
  applyLocaleMetadata(locale);

  for (const listener of listeners) {
    listener(locale);
  }
}

export function initLocale(): string {
  const stored = readStoredLocale();
  const persisted = stored === undefined ? undefined : exactSupported(stored);
  const next = persisted
    ?? navigatorCandidates().map(navigatorSupported).find((locale): locale is string => locale !== undefined)
    ?? 'en';

  commitLocale(next);

  return next;
}

export function getLocale(): string {
  return committedLocale;
}

export async function setLocale(locale: string): Promise<void> {
  const next = navigatorSupported(locale) ?? 'en';

  if (next === committedLocale) {
    return;
  }

  localeSwitchPending = true;

  for (const listener of pendingListeners) {
    listener(true);
  }

  const generation = preparePluginCatalogGeneration(next);

  await generation.promise;

  commitPluginCatalogGeneration(generation, () => {
    commitLocale(next);

    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Locale persistence is best-effort in private/embedded browser contexts.
    }
  });

  localeSwitchPending = false;

  for (const listener of pendingListeners) {
    listener(false);
  }
}

export function subscribeLocale(listener: LocaleListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function isLocaleSwitchPending(): boolean {
  return localeSwitchPending;
}

export function subscribeLocalePending(listener: (pending: boolean) => void): () => void {
  pendingListeners.add(listener);

  return () => {
    pendingListeners.delete(listener);
  };
}

export function hostT(key: string, values?: Record<string, unknown>, locale = committedLocale): string {
  const catalog = locale === 'en-XA' && isPseudoLocaleEnabled()
    ? PSEUDO_HOST_CATALOG
    : HOST_CATALOGS[locale] ?? HOST_CATALOGS.en;
  const message = catalogMessage(catalog, key)
    ?? catalogMessage(HOST_CATALOGS.en, key)
    ?? key;

  if (values === undefined) {
    return message;
  }

  return formatMessage(message, values, locale);
}

export function hostFormatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(normalizeFormatterLocale(committedLocale), options).format(value);
}

export function hostFormatDate(
  value: Date | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(normalizeFormatterLocale(committedLocale), options).format(value);
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
