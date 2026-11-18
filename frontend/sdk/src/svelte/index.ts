/** @module @mndw/sdk/svelte */
import {type Readable, readable} from 'svelte/store';
import type {PluginI18n} from '../i18n.js';
import type {Translator} from '../translator.js';

const snapshot = (i18n: PluginI18n): Translator => {
  return {
    t: (key, values) => i18n.t(key, values),
    formatNumber: (value, options) => i18n.formatNumber(value, options),
    formatDate: (value, options) => i18n.formatDate(value, options),
    get locale(): string {
      return i18n.locale;
    },
    direction: 'ltr',
  };
};

export function createTranslator(i18n: PluginI18n): Readable<Translator> {
  return readable(snapshot(i18n), (set) => {
    let isInitialLocale = true;
    const subscription = i18n.locale$.subscribe(() => {
      if (isInitialLocale) {
        isInitialLocale = false;

        return;
      }

      set(snapshot(i18n));
    });

    return () => subscription.unsubscribe();
  });
}

const IGNORED_MNDW_BUTTON_WARNING_CODES = new Set([
  'a11y_click_events_have_key_events',
  'a11y_no_static_element_interactions',
]);

/** Svelte compiler filter for false interaction warnings on the host-provided custom button. */
export const mndwSvelteWarningFilter = (warning: {code?: string; message?: string}): boolean => {
  return !IGNORED_MNDW_BUTTON_WARNING_CODES.has(warning.code ?? '')
    || !(warning.message ?? '').includes('<mndw-button>');
};

export type {Translator} from '../translator.js';
