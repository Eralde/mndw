import type {PluginI18n} from './i18n.js';

export function bindLocale(i18n: PluginI18n, render: () => void): () => void {
  render();

  return i18n.onChange(render);
}
