export interface Translator {
  t(key: string, values?: Record<string, unknown>): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatDate(value: Date, options?: Intl.DateTimeFormatOptions): string;
  readonly locale: string;
  /** Reserved forward-compatibility field; RTL is out of scope and value is always 'ltr'. */
  readonly direction: 'ltr';
}
