import {describe, expect, it} from 'vitest';
import enCatalog from './en.json';
import ruCatalog from './ru.json';

type Catalog = Record<string, unknown>;

function collectKeys(catalog: Catalog, prefix = ''): string[] {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;

    if (typeof value === 'string') {
      keys.push(path);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...collectKeys(value as Catalog, path));
    }
  }

  return keys;
}

function readMessage(catalog: Catalog, key: string): string {
  let value: unknown = catalog;

  for (const part of key.split('.')) {
    value = (value as Catalog)[part];
  }

  return typeof value === 'string' ? value : '';
}

function placeholdersOf(message: string): Set<string> {
  const placeholders = new Set<string>();

  for (const match of message.matchAll(/\{([^{}]+)\}/g)) {
    const name = match[1].trim().split(',')[0]?.trim() ?? '';

    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      placeholders.add(name);
    }
  }

  return placeholders;
}

describe('host i18n catalog parity', () => {
  const enKeys = collectKeys(enCatalog as Catalog);
  const ruKeys = collectKeys(ruCatalog as Catalog);

  it('exposes the same keys in en and ru', () => {
    expect([...ruKeys].sort()).toEqual([...enKeys].sort());
  });

  it('has a non-empty string for every key in both catalogs', () => {
    for (const key of enKeys) {
      expect(readMessage(enCatalog as Catalog, key), `en:${key}`).not.toBe('');
      expect(readMessage(ruCatalog as Catalog, key), `ru:${key}`).not.toBe('');
    }
  });

  it('uses the same placeholders for every key in en and ru', () => {
    for (const key of enKeys) {
      expect(
        [...placeholdersOf(readMessage(ruCatalog as Catalog, key))].sort(),
        `ru:${key}`,
      ).toEqual([...placeholdersOf(readMessage(enCatalog as Catalog, key))].sort());
    }
  });
});
