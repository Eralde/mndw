/** @module @mndw/sdk/bind-locale */
import type {PluginI18n} from './i18n.js';

export function bindLocale(i18n: PluginI18n, render: () => void): () => void {
  render();

  const subscription = i18n.change$.subscribe(render);

  return () => subscription.unsubscribe();
}
