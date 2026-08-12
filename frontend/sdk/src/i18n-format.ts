import IntlMessageFormat from 'intl-messageformat';

export function normalizeFormatterLocale(locale: string): string {
  return locale === 'en-XA' ? 'en' : locale;
}

export function formatMessage(
  message: string,
  values: Record<string, unknown> | undefined,
  locale: string,
): string {
  if (values === undefined) {
    return message;
  }

  try {
    const result = new IntlMessageFormat(message, normalizeFormatterLocale(locale)).format(values);

    return typeof result === 'string' ? result : String(result);
  } catch {
    return message;
  }
}
