import enCatalog from './i18n/en.json';
import ruCatalog from './i18n/ru.json';

type CatalogNode = string | CatalogRecord;
// Recursive catalog shape cannot use Record alias without triggering circular type expansion in Angular.
interface CatalogRecord {
  [key: string]: CatalogNode;
}
type UiCatalog = Record<string, CatalogNode>;
type LocaleListener = () => void;

const CATALOGS: Record<string, UiCatalog> = {
  en: enCatalog as UiCatalog,
  ru: ruCatalog as UiCatalog,
};

let activeLocale = 'en';
const listeners = new Set<LocaleListener>();

function canonicalize(locale: string): string {
  try {
    if (typeof Intl.getCanonicalLocales === 'function') {
      return Intl.getCanonicalLocales(locale)[0] ?? 'en';
    }

    if (typeof Intl.Locale === 'function') {
      return new Intl.Locale(locale).toString();
    }
  } catch {
    // Fall through to the English fallback below.
  }

  return 'en';
}

function resolveLocale(locale: string): string {
  const normalized = locale === 'en-XA' ? 'en' : canonicalize(locale);

  if (CATALOGS[normalized] !== undefined) {
    return normalized;
  }

  const language = normalized.split('-')[0];

  return CATALOGS[language] !== undefined ? language : 'en';
}

export function setMndwUiLocale(locale: string): void {
  const next = resolveLocale(locale);

  if (next === activeLocale) {
    return;
  }

  activeLocale = next;

  for (const listener of listeners) {
    listener();
  }
}

export function getMndwUiLocale(): string {
  return activeLocale;
}

export function getMndwUiText(key: string): string {
  return catalogMessage(CATALOGS[activeLocale], key)
    ?? catalogMessage(CATALOGS.en, key)
    ?? key;
}

function catalogMessage(catalog: UiCatalog | undefined, key: string): string | undefined {
  let value: CatalogNode | undefined = catalog;

  for (const part of key.split('.')) {
    if (typeof value !== 'object' || value === undefined) {
      return undefined;
    }

    value = value[part];
  }

  return typeof value === 'string' ? value : undefined;
}

export function subscribeMndwUiLocale(listener: LocaleListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}
