export type PluginCatalog = Readonly<Record<string, string>>;

function isCatalogRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function flattenCatalog(
  value: Record<string, unknown>,
  url: string,
  prefix: string,
  catalog: Record<string, string>,
): void {
  for (const [key, message] of Object.entries(value)) {
    const fullKey = prefix === '' ? key : `${prefix}.${key}`;

    if (typeof message === 'string') {
      if (Object.hasOwn(catalog, fullKey)) {
        throw new Error(`Plugin catalog ${url} contains duplicate key "${fullKey}"`);
      }

      catalog[fullKey] = message;
    } else if (isCatalogRecord(message)) {
      flattenCatalog(message, url, fullKey, catalog);
    } else {
      throw new Error(`Plugin catalog ${url} key "${fullKey}" must be a string or object`);
    }
  }
}

export function parseCatalog(value: unknown, url: string): PluginCatalog {
  if (!isCatalogRecord(value)) {
    throw new Error(`Plugin catalog ${url} must be a JSON object`);
  }

  const catalog: Record<string, string> = {};
  flattenCatalog(value, url, '', catalog);

  return Object.freeze(catalog);
}
