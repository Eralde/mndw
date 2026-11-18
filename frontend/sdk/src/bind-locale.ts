/** @module @mndw/sdk/bind-locale */
import type {PluginI18n} from './i18n.js';

export function bindLocale(i18n: PluginI18n, render: () => void): () => void {
  const subscription = i18n.locale$.subscribe(render);

  return () => subscription.unsubscribe();
}
