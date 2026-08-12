import {describe, expect, it} from 'vitest';
import {ManifestValidationError, validateManifest} from './manifest-validator.js';

const baseManifest = {
  manifestVersion: 3 as const,
  name: 'i18n-plugin',
  version: '1.0.0',
  type: 'widget' as const,
  label: 'I18n plugin',
  entry: 'index.js',
  size: {w: 4, h: 3},
};

const validI18n = {
  defaultLocale: 'en',
  locales: {
    en: 'i18n/en.json',
    ru: 'i18n/ru.json',
  },
};

describe('manifest i18n contract', () => {
  it('accepts manifests without i18n', () => {
    expect(() => validateManifest(baseManifest)).not.toThrow();
  });

  it('accepts a valid i18n descriptor and preserves it', () => {
    expect(validateManifest({...baseManifest, i18n: validI18n})).toMatchObject({i18n: validI18n});
  });

  it('accepts canonical locale keys', () => {
    expect(() => validateManifest({...baseManifest, i18n: validI18n})).not.toThrow();
  });

  it.each([
    ['defaultLocale is not present', {...validI18n, defaultLocale: 'de'}],
    ['locales is empty', {...validI18n, locales: {}}],
    ['catalog path is unsafe', {...validI18n, locales: {...validI18n.locales, ru: '../ru.json'}}],
    ['catalog path is not JSON', {...validI18n, locales: {...validI18n.locales, ru: 'i18n/ru.txt'}}],
    ['locale key is malformed', {...validI18n, locales: {...validI18n.locales, 'not a tag': 'i18n/ru.json'}}],
    ['locale keys collide after canonicalization', {
      ...validI18n,
      locales: {'en': 'i18n/en.json', 'EN-us': 'i18n/en-us.json', 'en-US': 'i18n/en-us-2.json'},
    }],
  ])('rejects when %s', (_name, i18n) => {
    expect(() => validateManifest({...baseManifest, i18n})).toThrow(ManifestValidationError);
  });

  it('rejects non-canonical locale spellings', () => {
    expect(() => validateManifest({
      ...baseManifest,
      i18n: {...validI18n, locales: {'EN-us': 'i18n/en-us.json'}},
    })).toThrow(ManifestValidationError);
  });
});
