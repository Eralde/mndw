import {DestroyRef, signal} from '@angular/core';
import type {PluginI18n} from '../i18n.js';
import type {Translator} from '../translator.js';

export function createTranslatorSignals(i18n: PluginI18n, destroyRef: DestroyRef): Translator {
  const revision = signal(0);
  const subscription = i18n.change$.subscribe(() => revision.update((value) => value + 1));

  destroyRef.onDestroy(() => subscription.unsubscribe());

  return {
    t: (key, values) => {
      revision();

      return i18n.t(key, values);
    },
    formatNumber: (value, options) => {
      revision();

      return i18n.formatNumber(value, options);
    },
    formatDate: (value, options) => {
      revision();

      return i18n.formatDate(value, options);
    },
    get locale(): string {
      revision();

      return i18n.locale;
    },
    direction: 'ltr',
  };
}
