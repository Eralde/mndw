import {describe, expect, it} from 'vitest';
import {
  SHARED_DEPENDENCIES,
  pluginDependencies,
  sharedDependencyVersions,
  sharedImportMap,
  sharedSpecifiers,
  versionedBundleUrl,
} from '../shared-dependencies.js';

describe('shared dependencies table', () => {
  it('gives every entry either an entryPoint or a stdin', () => {
    for (const entry of SHARED_DEPENDENCIES) {
      expect(Boolean(entry.entryPoint) !== Boolean(entry.stdin)).toBe(true);
    }
  });

  it('serves each bundle at a versioned /shared URL', () => {
    const rxjs = SHARED_DEPENDENCIES.find((d) => d.bundle === 'rxjs');

    expect(rxjs && versionedBundleUrl(rxjs)).toBe('/shared/rxjs@7.8.2.js');
  });

  it('maps every specifier to its versioned bundle in the import map', () => {
    const map = sharedImportMap();

    expect(map.rxjs).toBe('/shared/rxjs@7.8.2.js');
    expect(map['@angular/core']).toBe(map['@angular/core/rxjs-interop']);
  });

  it('stamps a specifier→version map for the lock file', () => {
    expect(sharedDependencyVersions()['@rci-tools/core']).toBe('0.2.0');
  });

  // Angular DI invariants, encoded as data. Splitting or inlining these re-creates the
  // duplicate class-identity / "No provider found" failures.
  describe('Angular invariants', () => {
    const angular = SHARED_DEPENDENCIES.filter((d) => d.framework === 'angular');

    it('co-bundles @angular/core with @angular/core/rxjs-interop in one file', () => {
      const core = angular.find((d) => d.bundle === 'angular-core');

      expect(core?.specifiers).toEqual(['@angular/core', '@angular/core/rxjs-interop']);
      expect(core?.stdin).toBeTruthy();
    });

    // common + platform-browser consume @angular/core and MUST keep it external — inlining core
    // internals into them yields duplicate DI class identities. (compiler doesn't import core.)
    it('keeps @angular/core external in the core-consuming bundles', () => {
      const consumers = angular.filter((d) => d.bundle === 'angular-common' || d.bundle === 'angular-platform-browser');

      expect(consumers).toHaveLength(2);

      for (const entry of consumers) {
        expect(entry.external).toContain('@angular/core');
      }
    });
  });

  describe('full d3 bundle', () => {
    const d3Entry = SHARED_DEPENDENCIES.find((entry) => entry.bundle === 'd3');

    it('ships one complete base-framework d3 entry at the pinned version', () => {
      expect(d3Entry).toEqual({
        specifiers: ['d3'],
        bundle: 'd3',
        version: '7.9.0',
        entryPoint: 'd3',
        framework: 'base',
      });
    });

    it('maps d3 to one versioned host URL', () => {
      expect(sharedImportMap().d3).toBe('/shared/d3@7.9.0.js');
      expect(sharedDependencyVersions().d3).toBe('7.9.0');
    });

    it('gives every plugin framework the full d3 external', () => {
      for (const framework of ['vanilla', 'svelte', 'vue', 'angular'] as const) {
        expect(pluginDependencies(framework)).toContain('d3');
      }
    });

    it('does not publish individual d3 submodule entries or d3 extensions', () => {
      expect(sharedSpecifiers()).not.toContain('d3-selection');
      expect(sharedSpecifiers()).not.toContain('d3-zoom');
      expect(sharedSpecifiers()).not.toContain('d3-dag');
      expect(SHARED_DEPENDENCIES.some((entry) => entry.bundle.startsWith('d3-'))).toBe(false);
    });
  });

  it('scopes framework externals: angular widgets get vue-free base + angular deps', () => {
    const angularDeps = pluginDependencies('angular');

    expect(angularDeps).toContain('rxjs');
    expect(angularDeps).toContain('@angular/core');
    expect(angularDeps).not.toContain('vue');
  });

  it('gives vanilla plugins the base shared deps only (no framework deps)', () => {
    const vanillaDeps = pluginDependencies('vanilla');

    expect(vanillaDeps).toEqual(['@rci-tools/core', 'rxjs', 'rxjs/operators', 'hash-wasm', 'd3', '@mndw/ui']);
    expect(vanillaDeps).not.toContain('vue');
    expect(vanillaDeps).not.toContain('@angular/core');
  });

  it('gives svelte plugins the same base deps as vanilla (svelte itself is bundled)', () => {
    expect(pluginDependencies('svelte')).toEqual(pluginDependencies('vanilla'));
  });

  it('gives vue plugins the base deps plus vue', () => {
    const vueDeps = pluginDependencies('vue');

    expect(vueDeps).toEqual(['@rci-tools/core', 'rxjs', 'rxjs/operators', 'hash-wasm', 'd3', '@mndw/ui', 'vue']);
    expect(vueDeps).not.toContain('@angular/core');
  });
});
