import {describe, expect, it} from 'vitest';
import {
  SHARED_DEPENDENCIES,
  pluginDependencies,
  sharedDependencyVersions,
  sharedImportMap,
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

  // Angular DI invariants, encoded as data (design §4). Splitting or inlining these re-creates the
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

  it('scopes framework externals: angular widgets get vue-free base + angular deps', () => {
    const angularDeps = pluginDependencies('angular');

    expect(angularDeps).toContain('rxjs');
    expect(angularDeps).toContain('@angular/core');
    expect(angularDeps).not.toContain('vue');
  });
});
