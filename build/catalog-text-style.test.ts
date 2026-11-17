import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CATALOG_ROOTS = [
  'frontend/host/src/i18n',
  'plugins/builtin',
  'plugins/examples',
  'tooling/cli/templates',
] as const;

function jsonFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(directory, entry.name));
}

function catalogFiles(): string[] {
  const files: string[] = [];

  for (const root of CATALOG_ROOTS) {
    const absoluteRoot = join(REPO_ROOT, root);

    if (root === 'frontend/host/src/i18n') {
      files.push(...jsonFiles(absoluteRoot));
      continue;
    }

    for (const entry of readdirSync(absoluteRoot, {withFileTypes: true})) {
      if (!entry.isDirectory() || entry.name === '.nocommit') {
        continue;
      }

      const i18nRoot = join(absoluteRoot, entry.name, 'i18n');

      if (existsSync(i18nRoot)) {
        files.push(...jsonFiles(i18nRoot));
      }
    }
  }

  return files.sort();
}

function messageEntries(value: unknown, key = ''): Array<{key: string; value: string}> {
  if (typeof value === 'string') {
    return [{key, value}];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => messageEntries(entry, `${key}[${index}]`));
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([childKey, childValue]) => {
      const childPath = key === '' ? childKey : `${key}.${childKey}`;

      return messageEntries(childValue, childPath);
    });
  }

  return [];
}

function textStyleViolations(file: string): string[] {
  const locale = file.slice(file.lastIndexOf('/') + 1, -'.json'.length);
  const messages = messageEntries(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  const violations: string[] = [];

  for (const {key, value} of messages) {
    const report = (rule: string): void => {
      violations.push(`${relative(REPO_ROOT, file)}:${key}: ${rule}: ${JSON.stringify(value)}`);
    };

    if (value.includes('...')) {
      report('use the ellipsis character');
    }

    if (value.startsWith('+ ')) {
      report('remove the leading plus sign');
    }

    if (value.includes('"')) {
      report('use typographic double quotes');
    }

    if (locale === 'en' && /[«»]/u.test(value)) {
      report('use English typographic quotes');
    }

    if (locale === 'ru' && /[“”]/u.test(value)) {
      report('use Russian typographic quotes');
    }
  }

  return violations;
}

describe('catalog text style', () => {
  it('uses localized typographic quotes, ellipses, and icon-free labels', () => {
    const violations = catalogFiles().flatMap((file) => textStyleViolations(file));

    expect(violations).toEqual([]);
  });
});
