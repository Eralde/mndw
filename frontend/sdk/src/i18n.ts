import type {Observable} from 'rxjs';

export interface PluginManifestI18n {
  defaultLocale: string;
  locales: Record<string, string>;
}

export interface PluginI18n {
  readonly locale: string;
  readonly direction: 'ltr';
  t(key: string, values?: Record<string, unknown>): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatDate(value: Date, options?: Intl.DateTimeFormatOptions): string;
  readonly change$: Observable<void>;
}
