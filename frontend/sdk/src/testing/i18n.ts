import type {PluginI18n} from '../i18n.js';
import {parseCatalog} from '../catalog.js';
import {formatMessage, normalizeFormatterLocale} from '../i18n-format.js';

export type TestCatalog = Record<string, string> | Record<string, unknown>;

export interface TestI18n extends PluginI18n {
  setLocale(next: string, catalog: TestCatalog): void;
}

export function createTestI18n(catalog: TestCatalog = {}, locale = 'en'): TestI18n {
  let currentCatalog = parseCatalog(catalog, '<test catalog>');
  let currentLocale = locale;
  const listeners = new Set<() => void>();

  const i18n: TestI18n = {
    get locale(): string {
      return currentLocale;
    },
    direction: 'ltr',
    t: (key, values) => formatMessage(currentCatalog[key] ?? key, values, currentLocale),
    formatNumber: (value, options) =>
      new Intl.NumberFormat(normalizeFormatterLocale(currentLocale), options).format(value),
    formatDate: (value, options) =>
      new Intl.DateTimeFormat(normalizeFormatterLocale(currentLocale), options).format(value),
    onChange: (callback) => {
      listeners.add(callback);

      return () => {
        listeners.delete(callback);
      };
    },
    setLocale: (next, nextCatalog) => {
      currentLocale = next;
      currentCatalog = parseCatalog(nextCatalog, '<test catalog>');

      for (const listener of listeners) {
        listener();
      }
    },
  };

  return Object.freeze(i18n);
}
