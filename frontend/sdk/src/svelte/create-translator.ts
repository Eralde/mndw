import {readable, type Readable} from 'svelte/store';
import type {PluginI18n} from '../i18n.js';
import type {Translator} from '../translator.js';

function snapshot(i18n: PluginI18n): Translator {
  return {
    t: (key, values) => i18n.t(key, values),
    formatNumber: (value, options) => i18n.formatNumber(value, options),
    formatDate: (value, options) => i18n.formatDate(value, options),
    get locale(): string {
      return i18n.locale;
    },
    direction: 'ltr',
  };
}

export function createTranslator(i18n: PluginI18n): Readable<Translator> {
  return readable(snapshot(i18n), (set) => i18n.onChange(() => set(snapshot(i18n))));
}
