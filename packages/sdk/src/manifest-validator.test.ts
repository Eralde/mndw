import {readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {ManifestValidationError, validateManifest} from './manifest-validator.js';

const fixturesRoot = resolve(import.meta.dirname, '..', 'fixtures', 'manifests');

const loadFixtures = (kind: 'valid' | 'invalid'): Array<{name: string; data: unknown}> => {
  const dir = resolve(fixturesRoot, kind);

  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({name: file, data: JSON.parse(readFileSync(resolve(dir, file), 'utf8'))}));
};

// The shared fixture corpus is the source of truth for Zod ⇄ Go validator parity (design §3.2).
// Every file under valid/ must parse; every file under invalid/ must be rejected.
describe('manifest fixture corpus', () => {
  const validFixtures = loadFixtures('valid');
  const invalidFixtures = loadFixtures('invalid');

  it('has a non-trivial corpus', () => {
    expect(validFixtures.length).toBeGreaterThanOrEqual(8);
    expect(invalidFixtures.length).toBeGreaterThanOrEqual(30);
  });

  it.each(validFixtures)('accepts valid/$name', ({data}) => {
    expect(() => validateManifest(data)).not.toThrow();
  });

  it.each(invalidFixtures)('rejects invalid/$name', ({data}) => {
    expect(() => validateManifest(data)).toThrow(ManifestValidationError);
  });
});

describe('validateManifest behavior', () => {
  it('returns typed widget data with the size preserved', () => {
    const result = validateManifest({
      manifestVersion: 2,
      name: 'test-widget',
      version: '2.0.0',
      type: 'widget',
      label: 'Test Widget',
      entry: 'index.js',
      size: {w: 4, h: 3},
    });

    expect(result.type).toBe('widget');
    expect(result.type === 'widget' && result.size.w).toBe(4);
  });

  it('retains widget fixedHeight in validated output', () => {
    const result = validateManifest({
      manifestVersion: 2,
      name: 'fixed-widget',
      version: '2.0.0',
      type: 'widget',
      label: 'Fixed Widget',
      entry: 'index.js',
      size: {w: 4, h: 3},
      fixedHeight: true,
    });

    expect(result.type === 'widget' && result.fixedHeight).toBe(true);
  });

  it('returns typed page data with the route preserved', () => {
    const result = validateManifest({
      manifestVersion: 2,
      name: 'test-page',
      version: '2.0.0',
      type: 'page',
      label: 'Test Page',
      entry: 'index.js',
      route: '/demo',
    });

    expect(result.type).toBe('page');
    expect(result.type === 'page' && result.route).toBe('/demo');
  });

  it('accepts and strips an editor $schema reference', () => {
    const result = validateManifest({
      $schema: '../manifest.schema.json',
      manifestVersion: 2,
      name: 'test-widget',
      version: '2.0.0',
      type: 'widget',
      label: 'Test Widget',
      entry: 'index.js',
      size: {w: 4, h: 3},
    });

    expect('$schema' in result).toBe(false);
  });

  it('normalizes a lowercase endpoint method to uppercase', () => {
    const result = validateManifest({
      manifestVersion: 2,
      name: 'backend-plugin',
      version: '2.0.0',
      type: 'widget',
      label: 'Backend Plugin',
      entry: 'index.js',
      size: {w: 4, h: 3},
      backend: {
        scripts: [{id: 's1', source: 'script.sh', runtime: 'sh'}],
        endpoints: [{id: 'e1', method: 'get', path: 'data', scriptId: 's1'}],
      },
    });

    const endpoint = result.backend?.endpoints?.[0];

    expect(endpoint?.method).toBe('GET');
  });

  it('surfaces the plugin name in the error message', () => {
    expect(() =>
      validateManifest({
        manifestVersion: 2,
        name: 'broken-widget',
        version: '2.0.0',
        type: 'widget',
        label: 'Broken',
        entry: 'index.js',
        // missing size
      })
    ).toThrow(/broken-widget/);
  });

  it('reports "unknown" when the name is unavailable', () => {
    expect(() => validateManifest({type: 'widget'})).toThrow(/unknown/);
  });
});

describe('backend.assets', () => {
  const base = {
    manifestVersion: 2 as const,
    name: 'asset-plugin',
    version: '0.1.0',
    type: 'widget' as const,
    label: 'Asset Plugin',
    entry: 'index.js',
    size: {w: 2, h: 2},
  };

  it('accepts a safe relative asset path', () => {
    const manifest = validateManifest({
      ...base,
      backend: {assets: ['backend/ping-util']},
    });

    expect(manifest.backend?.assets).toEqual(['backend/ping-util']);
  });

  it.each([
    ['/abs/ping-util'],
    ['../ping-util'],
    ['backend\\ping-util'],
    [''],
  ])('rejects unsafe asset path %s', (bad) => {
    expect(() => validateManifest({...base, backend: {assets: [bad]}})).toThrow();
  });
});
