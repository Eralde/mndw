import {onMounted, onUnmounted, ref} from 'vue';
import type {PluginI18n} from '../i18n.js';
import type {Translator} from '../translator.js';

export function useTranslator(i18n: PluginI18n): Translator {
  const revision = ref(0);
  let unsubscribe = (): void => {};

  onMounted(() => {
    unsubscribe = i18n.onChange(() => {
      revision.value += 1;
    });
  });
  onUnmounted(() => unsubscribe());

  return {
    t: (key, values) => {
      void revision.value;

      return i18n.t(key, values);
    },
    formatNumber: (value, options) => {
      void revision.value;

      return i18n.formatNumber(value, options);
    },
    formatDate: (value, options) => {
      void revision.value;

      return i18n.formatDate(value, options);
    },
    get locale(): string {
      void revision.value;

      return i18n.locale;
    },
    direction: 'ltr',
  };
}
