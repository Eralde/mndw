import type {Observable} from 'rxjs';
import type {Translator} from './translator.js';

export interface PluginManifestI18n {
  defaultLocale: string;
  locales: Record<string, string>;
}

export interface PluginI18n extends Translator {
  /** Emits the active locale after its plugin catalog is applied, and completes when the plugin unmounts. */
  readonly locale$: Observable<string>;
}
