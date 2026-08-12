import {resolve} from 'node:path';

import {describe, expect, it} from 'vitest';

import {CliError} from './errors.js';
import {validatePluginCatalogs} from './i18n-validator.js';
import {readManifest} from './manifest.js';

const fixturesRoot = resolve(import.meta.dirname, '../fixtures/i18n-packages');

const loadFixture = (kind: 'valid' | 'invalid', name: string): {pluginDir: string; manifest: ReturnType<typeof readManifest>['manifest']} => {
  const pluginDir = resolve(fixturesRoot, kind, name);

  return {pluginDir, manifest: readManifest(pluginDir).manifest};
};

describe('validatePluginCatalogs', () => {
  it('accepts a default-only catalog', () => {
    const {pluginDir, manifest} = loadFixture('valid', 'default-only');

    expect(validatePluginCatalogs(pluginDir, manifest, {strict: false})).toEqual([]);
  });

  it('accepts alternate catalogs with matching keys', () => {
    const {pluginDir, manifest} = loadFixture('valid', 'alternate-and-default');

    expect(validatePluginCatalogs(pluginDir, manifest, {strict: false})).toEqual([]);
  });

  it('returns deterministic parity warnings by locale and key', () => {
    const {pluginDir, manifest} = loadFixture('valid', 'key-parity-gap');
    const warnings = validatePluginCatalogs(pluginDir, manifest, {strict: false});

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ru');
    expect(warnings[0]).toContain('extra');
  });

  it('escalates parity warnings in strict mode', () => {
    const {pluginDir, manifest} = loadFixture('valid', 'key-parity-gap');

    expect(() => validatePluginCatalogs(pluginDir, manifest, {strict: true})).toThrow(CliError);
  });

  it.each([
    'malformed-json',
    'non-object',
    'non-string',
    'missing-file',
    'invalid-icu',
  ])('rejects invalid/%s', (name) => {
    const {pluginDir, manifest} = loadFixture('invalid', name);

    expect(() => validatePluginCatalogs(pluginDir, manifest, {strict: false})).toThrow(CliError);
  });

  it('reports the plugin, locale, and declared path in structural failures', () => {
    const {pluginDir, manifest} = loadFixture('invalid', 'non-string');

    expect(() => validatePluginCatalogs(pluginDir, manifest, {strict: false})).toThrow(
      /i18n-non-string.*en.*i18n\/en\.json/i,
    );
  });
});
