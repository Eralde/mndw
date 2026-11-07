/**
 * Single source of truth for host-provided shared dependencies.
 *
 * Plugins must NOT bundle these — the host serves each one once as a versioned `/shared/<name>@<v>.js`
 * bundle and wires them via an import map (dev and prod). Consumers derive from `SHARED_DEPENDENCIES`:
 *
 * - host build — builds one `/shared/<name>@<v>.js` per entry + the import map.
 * - CLI pack — externals passed to esbuild when packing a plugin; stamps built-against versions into
 *   `mndw.lock.json`.
 * - daemon dev static serving.
 */

/**
 * Which plugin framework must treat the external dependency as shared:
 * - `base` — every plugin (regardless of framework) must not bundle it.
 * - `vue` / `angular` — only plugins of that framework.
 */
export type DependencyConsumer =
  | 'base'
  | 'vue'
  | 'angular';

export interface SharedDependency {
  /** Import specifiers that resolve to this bundle at runtime (import map, plugin externals). */
  specifiers: string[];
  /** Output filename stem, served (versioned) at `/shared/<bundle>@<version>.js`. */
  bundle: string;
  /**
   * Version the host provides. Stamped into a plugin's `mndw.lock.json` at pack time; the host warns
   * on a major mismatch at load. Tracks the versions the host actually pins as dependencies change.
   */
  version: string;
  /** esbuild entry: a single module specifier. Mutually exclusive with `stdin`. */
  entryPoint?: string;
  /** esbuild entry: inline contents, used to co-bundle several specifiers into one file. */
  stdin?: string;
  /** Modules esbuild must keep external (resolved via import map at runtime), not inline. */
  external?: string[];
  /** Extra JS prepended to the bundle (e.g. Vue feature flags). */
  banner?: string;
  /** Plugin framework that requires this external. */
  framework: DependencyConsumer;
}

export const SHARED_DEPENDENCIES: SharedDependency[] = [
  {
    specifiers: ['@rci-tools/core'],
    bundle: 'rci-tools-core',
    version: '0.6.0',
    entryPoint: '@rci-tools/core',
    external: ['rxjs', 'hash-wasm'],
    framework: 'base',
  },
  {
    specifiers: ['rxjs'],
    bundle: 'rxjs',
    version: '7.8.2',
    entryPoint: 'rxjs',
    framework: 'base',
  },
  {
    specifiers: ['rxjs/operators'],
    bundle: 'rxjs-operators',
    version: '7.8.2',
    entryPoint: 'rxjs/operators',
    framework: 'base',
  },
  {
    specifiers: ['hash-wasm'],
    bundle: 'hash-wasm',
    version: '4.12.0',
    entryPoint: 'hash-wasm',
    framework: 'base',
  },
  {
    specifiers: ['d3'],
    bundle: 'd3',
    version: '7.9.0',
    entryPoint: 'd3',
    framework: 'base',
  },
  {
    specifiers: ['@mndw/ui'],
    bundle: 'mndw-ui',
    version: '0.1.5',
    entryPoint: '@mndw/ui',
    external: ['d3'],
    framework: 'base',
  },
  {
    specifiers: ['vue'],
    bundle: 'vue',
    version: '3.5.39',
    entryPoint: 'vue',
    banner: 'var __VUE_OPTIONS_API__=true,__VUE_PROD_DEVTOOLS__=false,__VUE_PROD_HYDRATION_MISMATCH_DETAILS__=false;',
    framework: 'vue',
  },
  {
    specifiers: ['zone.js'],
    bundle: 'zone',
    version: '0.15.1',
    entryPoint: 'zone.js',
    framework: 'angular',
  },
  {
    // `@angular/core` and `@angular/core/rxjs-interop` MUST share one file, or rxjs-interop inlines
    // Angular internals and breaks DI with duplicate class identities.
    specifiers: ['@angular/core', '@angular/core/rxjs-interop'],
    bundle: 'angular-core',
    version: '21.2.18',
    stdin: 'export * from \'@angular/core\'; export * from \'@angular/core/rxjs-interop\';',
    external: ['rxjs', 'rxjs/operators', '@angular/compiler'],
    framework: 'angular',
  },
  {
    // All Angular bundles keep `@angular/core` external — inlining core internals here yields
    // duplicate DI class identities and "No provider found" errors.
    specifiers: ['@angular/common'],
    bundle: 'angular-common',
    version: '21.2.18',
    entryPoint: '@angular/common',
    external: ['rxjs', '@angular/compiler', '@angular/core'],
    framework: 'angular',
  },
  {
    specifiers: ['@angular/platform-browser'],
    bundle: 'angular-platform-browser',
    version: '21.2.18',
    entryPoint: '@angular/platform-browser',
    external: ['rxjs', '@angular/compiler', '@angular/core'],
    framework: 'angular',
  },
  {
    specifiers: ['@angular/compiler'],
    bundle: 'angular-compiler',
    version: '21.2.18',
    entryPoint: '@angular/compiler',
    external: ['rxjs'],
    framework: 'angular',
  },
];

/** Versioned runtime URL a bundle is served at: `/shared/<bundle>@<version>.js`. */
export const versionedBundleUrl = (entry: SharedDependency): string => `/shared/${entry.bundle}@${entry.version}.js`;

/**
 * `specifier -> /shared/<bundle>@<version>.js` for every specifier. Used by the import map in dev and
 * prod.
 */
export const sharedImportMap = (): Record<string, string> => {
  return Object.fromEntries(
    SHARED_DEPENDENCIES.flatMap((entry) => entry.specifiers.map((specifier) => [specifier, versionedBundleUrl(entry)])),
  );
};

/** All import specifiers (esbuild/rollup `external`). */
export const sharedSpecifiers = (): string[] => SHARED_DEPENDENCIES.flatMap((entry) => entry.specifiers);

/**
 * Specifiers a plugin of the given framework must not bundle (esbuild `external` at pack time).
 * `vanilla` and `svelte` both receive the base shared deps only (svelte itself is bundled); `vue`
 * and `angular` add their framework externals.
 */
export const pluginDependencies = (framework: 'vanilla' | 'svelte' | 'vue' | 'angular'): string[] => {
  return SHARED_DEPENDENCIES
    .filter((entry) => entry.framework === 'base' || entry.framework === framework)
    .flatMap((entry) => entry.specifiers);
};

/** `specifier -> version` map, stamped into a plugin's `mndw.lock.json` at pack time. */
export const sharedDependencyVersions = (): Record<string, string> => {
  return Object.fromEntries(
    SHARED_DEPENDENCIES.flatMap((entry) => entry.specifiers.map((specifier) => [specifier, entry.version])),
  );
};
