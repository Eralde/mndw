import {onMounted, onUnmounted, ref} from 'vue';
import type {PluginI18n} from '../i18n.js';
import type {Translator} from '../translator.js';

export function useTranslator(i18n: PluginI18n): Translator {
  const revision = ref(0);
  let renderedLocale = i18n.locale;
  let unsubscribe = (): void => {};

  onMounted(() => {
    let firstEmission = true;
    const subscription = i18n.locale$.subscribe((locale) => {
      if (firstEmission) {
        firstEmission = false;

        if (locale === renderedLocale) {
          return;
        }
      }

      revision.value += 1;
    });

    unsubscribe = () => subscription.unsubscribe();
  });
  onUnmounted(() => unsubscribe());

  return {
    t: (key, values) => {
      renderedLocale = i18n.locale;
      void revision.value;

      return i18n.t(key, values);
    },
    formatNumber: (value, options) => {
      renderedLocale = i18n.locale;
      void revision.value;

      return i18n.formatNumber(value, options);
    },
    formatDate: (value, options) => {
      renderedLocale = i18n.locale;
      void revision.value;

      return i18n.formatDate(value, options);
    },
    get locale(): string {
      renderedLocale = i18n.locale;
      void revision.value;

      return i18n.locale;
    },
    direction: 'ltr',
  };
}
