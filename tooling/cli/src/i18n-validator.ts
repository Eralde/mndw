import {readFileSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';

import {parse} from '@formatjs/icu-messageformat-parser';
import type {PluginManifestOutput} from '@mndw/sdk-internal';

import {CliError} from './errors.js';

export interface CatalogValidationOptions {
  readonly strict: boolean;
}

type Catalog = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidCatalog(manifest: PluginManifestOutput, locale: string, declaredPath: string, reason: string): never {
  throw new CliError(`Invalid catalog for ${manifest.name} locale ${locale} at ${declaredPath}: ${reason}`);
}

function resolveCatalogPath(
  pluginDir: string,
  manifest: PluginManifestOutput,
  locale: string,
  declaredPath: string,
): string {
  const resolvedPluginDir = resolve(pluginDir);
  const catalogPath = resolve(resolvedPluginDir, declaredPath);
  const relativePath = relative(resolvedPluginDir, catalogPath);

  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    invalidCatalog(manifest, locale, declaredPath, 'path escapes the plugin directory');
  }

  return catalogPath;
}

function readCatalog(
  pluginDir: string,
  manifest: PluginManifestOutput,
  locale: string,
  declaredPath: string,
): Catalog {
  const catalogPath = resolveCatalogPath(pluginDir, manifest, locale, declaredPath);
  let source: string;

  try {
    source = readFileSync(catalogPath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    invalidCatalog(manifest, locale, declaredPath, `file cannot be read: ${detail}`);
  }

  let value: unknown;

  try {
    value = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    invalidCatalog(manifest, locale, declaredPath, `invalid JSON: ${detail}`);
  }

  if (!isRecord(value)) {
    invalidCatalog(manifest, locale, declaredPath, 'catalog must be a non-null JSON object');
  }

  const catalog: Catalog = {};

  flattenCatalog(value, manifest, locale, declaredPath, '', catalog);

  return catalog;
}

function flattenCatalog(
  value: Record<string, unknown>,
  manifest: PluginManifestOutput,
  locale: string,
  declaredPath: string,
  prefix: string,
  catalog: Catalog,
): void {
  for (const [key, message] of Object.entries(value)) {
    const fullKey = prefix === '' ? key : `${prefix}.${key}`;

    if (typeof message === 'string') {
      try {
        parse(message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);

        invalidCatalog(manifest, locale, declaredPath, `invalid ICU message for key ${fullKey}: ${detail}`);
      }

      if (catalog[fullKey] !== undefined) {
        invalidCatalog(manifest, locale, declaredPath, `duplicate key ${fullKey}`);
      }

      catalog[fullKey] = message;

      continue;
    }

    if (isRecord(message)) {
      flattenCatalog(message, manifest, locale, declaredPath, fullKey, catalog);

      continue;
    }

    invalidCatalog(manifest, locale, declaredPath, `value for key ${fullKey} must be a string or object`);
  }
}

function parityWarnings(
  manifest: PluginManifestOutput,
  defaultLocale: string,
  defaultCatalog: Catalog,
  locale: string,
  catalog: Catalog,
): string[] {
  const warnings: string[] = [];
  const defaultKeys = Object.keys(defaultCatalog).sort();
  const localeKeys = Object.keys(catalog).sort();

  for (const key of defaultKeys) {
    if (!(key in catalog)) {
      warnings.push(`${manifest.name} locale ${locale} is missing key ${key} from ${defaultLocale}`);
    }
  }

  for (const key of localeKeys) {
    if (!(key in defaultCatalog)) {
      warnings.push(`${manifest.name} locale ${locale} has extra key ${key} not present in ${defaultLocale}`);
    }
  }

  return warnings;
}

export function validatePluginCatalogs(
  pluginDir: string,
  manifest: PluginManifestOutput,
  options: CatalogValidationOptions,
): string[] {
  if (manifest.i18n === undefined) {
    return [];
  }

  const i18n = manifest.i18n;
  const entries = Object.entries(manifest.i18n.locales).sort(([left], [right]) => left.localeCompare(right));
  const catalogs = new Map<string, Catalog>();

  for (const [locale, declaredPath] of entries) {
    catalogs.set(locale, readCatalog(pluginDir, manifest, locale, declaredPath));
  }

  const defaultCatalog = catalogs.get(i18n.defaultLocale);

  if (defaultCatalog === undefined) {
    throw new CliError(
      `Invalid catalog for ${manifest.name}: default locale ${i18n.defaultLocale} was not loaded`,
    );
  }

  const warnings = entries
    .filter(([locale]) => locale !== i18n.defaultLocale)
    .flatMap(([locale]) => {
      const catalog = catalogs.get(locale);

      return catalog === undefined ? [] : parityWarnings(manifest, i18n.defaultLocale, defaultCatalog, locale, catalog);
    });

  if (options.strict && warnings.length > 0) {
    throw new CliError(warnings.join('\n'));
  }

  return warnings;
}
