import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {describe, expect, it} from 'vitest';

import type {PluginManifestOutput} from '@mndw/sdk';

import {CliError} from './errors.js';
import {buildLock, findBundledSharedDependencies, parseLock, resolveSdkVersion, serializeLock} from './lock.js';

function widgetManifest(): PluginManifestOutput {
  return {
    manifestVersion: 3,
    name: 'sample-widget',
    version: '1.2.3',
    type: 'widget',
    label: 'Sample',
    entry: 'index.js',
    size: {w: 3, h: 2},
  } as PluginManifestOutput;
}

describe('resolveSdkVersion', () => {
  it('reads the resolved @mndw/sdk package version, not a plugin dependency range', () => {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve('@mndw/sdk'));
    let sdkPkg: {name?: string; version?: string} | undefined;

    while (sdkPkg === undefined) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {name?: string; version?: string};

        if (parsed.name === '@mndw/sdk') {
          sdkPkg = parsed;
        }
      } catch {
        // keep walking up
      }

      const parent = dirname(dir);

      if (parent === dir) {
        break;
      }

      dir = parent;
    }

    expect(sdkPkg).toBeDefined();
    expect(resolveSdkVersion()).toBe(sdkPkg?.version);
    expect(resolveSdkVersion()).not.toMatch(/^(workspace:|\^|~)/);
  });
});

describe('buildLock', () => {
  it('produces a version-1 lock with sorted base shared deps for a vanilla plugin', () => {
    const lock = buildLock(widgetManifest(), 'vanilla');

    expect(lock.lockVersion).toBe(1);
    expect(lock.plugin).toEqual({name: 'sample-widget', version: '1.2.3'});
    expect(lock.framework).toBe('vanilla');
    expect(lock.sdkVersion).toBe(resolveSdkVersion());
    expect(Object.keys(lock.sharedDependencies)).toEqual([
      '@mndw/ui',
      '@rci-tools/core',
      'd3',
      'hash-wasm',
      'rxjs',
      'rxjs/operators',
    ]);
    expect(lock.sharedDependencies.rxjs).toBe('7.8.2');
    expect(lock.sharedDependencies['@rci-tools/core']).toBe('0.2.0');
    expect(lock.sharedDependencies.d3).toBe('7.9.0');
  });

  it('records the same base shared deps for a svelte plugin', () => {
    expect(buildLock(widgetManifest(), 'svelte').sharedDependencies).toEqual(
      buildLock(widgetManifest(), 'vanilla').sharedDependencies,
    );
  });
});

describe('serializeLock', () => {
  it('is deterministic, indented, and newline-terminated', () => {
    const lock = buildLock(widgetManifest(), 'vanilla');
    const text = serializeLock(lock);

    expect(text.endsWith('\n')).toBe(true);
    expect(text).toBe(serializeLock(lock));
    expect(text).toContain('"lockVersion": 1');
    expect(parseLock(text)).toEqual(lock);
  });
});

describe('parseLock', () => {
  it('rejects malformed JSON with a deterministic reader error', () => {
    expect(() => parseLock('{not json')).toThrow(CliError);
  });

  it('rejects an unknown lock version', () => {
    expect(() => parseLock(JSON.stringify({lockVersion: 2}))).toThrow(CliError);
  });
});

describe('findBundledSharedDependencies', () => {
  const specifiers = ['@rci-tools/core', 'rxjs', 'rxjs/operators', 'hash-wasm'];

  it('flags a shared dependency present as a bundled input', () => {
    const metafile = {
      inputs: {
        'src/index.ts': {},
        'node_modules/.pnpm/rxjs@7.8.2/node_modules/rxjs/internal/index.js': {},
      },
    };

    expect(findBundledSharedDependencies(metafile, specifiers)).toEqual(['rxjs']);
  });

  it('maps a scoped subpath specifier back to its package', () => {
    const metafile = {
      inputs: {'node_modules/@rci-tools/core/dist/index.js': {}},
    };

    expect(findBundledSharedDependencies(metafile, specifiers)).toEqual(['@rci-tools/core']);
  });

  it('passes an output that only bundles plugin source', () => {
    const metafile = {inputs: {'src/index.ts': {}, 'src/App.svelte': {}}};

    expect(findBundledSharedDependencies(metafile, specifiers)).toEqual([]);
  });
});
