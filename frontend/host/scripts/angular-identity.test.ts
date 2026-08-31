import {mkdtempSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SHARED_DEPENDENCIES, sharedSpecifiers} from '@mndw/sdk/shared-dependencies';
import {type BuildOptions, type BuildResult, type Metafile, type Plugin, build} from 'esbuild';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const specifierToFile = new Map<string, string>();

for (const entry of SHARED_DEPENDENCIES) {
  for (const specifier of entry.specifiers) {
    specifierToFile.set(specifier, `${entry.bundle}@${entry.version}.js`);
  }
}

function requiredSharedFile(specifier: string): string {
  const file = specifierToFile.get(specifier);

  if (file === undefined) {
    throw new Error(`Missing shared bundle mapping for ${specifier}`);
  }

  return file;
}

const coreFile = requiredSharedFile('@angular/core');
const loadNativeModule = createRequire(import.meta.url);

/** esbuild plugin: keep shared specifiers external, rewritten to their relative sibling bundle file. */
function externalizeShared(): Plugin {
  return {
    name: 'externalize-shared',
    setup(pluginBuild) {
      pluginBuild.onResolve({filter: /.*/}, (args) => {
        const file = specifierToFile.get(args.path);

        return file ? {path: `./${file}`, external: true} : null;
      });
    },
  };
}

/** Production-shaped bundle options for one SDK shared entry (mirrors bundle-shared.ts). */
function productionBundle(entry: (typeof SHARED_DEPENDENCIES)[number], outDir: string): BuildOptions {
  const options: BuildOptions = {
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    metafile: true,
    outfile: join(outDir, `${entry.bundle}@${entry.version}.js`),
    external: entry.external,
  };

  if (entry.stdin !== undefined) {
    options.stdin = {contents: entry.stdin, resolveDir: process.cwd(), loader: 'ts'};
  } else {
    if (entry.entryPoint === undefined) {
      throw new Error(`Shared dependency ${entry.bundle} is missing both stdin and entryPoint`);
    }

    options.entryPoints = [entry.entryPoint];
  }

  if (entry.banner !== undefined) {
    options.banner = {js: entry.banner};
  }

  return options;
}

function entryFor(bundle: string): (typeof SHARED_DEPENDENCIES)[number] {
  const entry = SHARED_DEPENDENCIES.find((e) => e.bundle === bundle);

  if (entry === undefined) {
    throw new Error(`Missing shared dependency entry for ${bundle}`);
  }

  return entry;
}

function requiredMetafile(result: BuildResult, label: string): Metafile {
  if (result.metafile === undefined) {
    throw new Error(`esbuild result for ${label} did not include a metafile`);
  }

  return result.metafile;
}

/** Package name of a shared specifier (`rxjs/operators` -> `rxjs`, `@a/b/c` -> `@a/b`). */
function packageNameOf(specifier: string): string {
  const s = specifier.split('/');

  return specifier.startsWith('@') ? `${s[0]}/${s[1]}` : s[0];
}

/** Shared packages that leaked into a bundle, read from the esbuild metafile inputs. */
function bundledShared(metafile: Metafile, specifiers: readonly string[]): string[] {
  const packages = [...new Set(specifiers.map(packageNameOf))];
  const found = new Set<string>();

  for (const input of Object.keys(metafile.inputs)) {
    for (const p of packages) {
      if (input.includes(`node_modules/${p}/`)) {
        found.add(p);
      }
    }
  }

  return [...found];
}

let tmp: string;
let consumerAMeta: Metafile;
let consumerBMeta: Metafile;
let commonMeta: Metafile;
let platformMeta: Metafile;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mndw-angular-identity-'));

  // Self-contained @angular/core for the runtime-identity check: inline everything so it loads in-process.
  await build({
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: [],
    stdin: {contents: 'export * from \'@angular/core\';', resolveDir: process.cwd(), loader: 'ts'},
    outfile: join(tmp, coreFile),
  });

  // Two independent consumers that externalize @angular/core -> the identical relative core file.
  const consumerSrc = 'export {InjectionToken} from \'@angular/core\';';
  const consumerA = await build({
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    metafile: true,
    stdin: {contents: consumerSrc, resolveDir: process.cwd(), loader: 'ts'},
    outfile: join(tmp, 'consumer-a.js'),
    plugins: [externalizeShared()],
  });
  const consumerB = await build({
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    metafile: true,
    stdin: {contents: consumerSrc, resolveDir: process.cwd(), loader: 'ts'},
    outfile: join(tmp, 'consumer-b.js'),
    plugins: [externalizeShared()],
  });

  consumerAMeta = requiredMetafile(consumerA, 'consumer-a');
  consumerBMeta = requiredMetafile(consumerB, 'consumer-b');

  // Production-shaped bundles for the non-inlining metafile checks (never imported).
  const common = await build(productionBundle(entryFor('angular-common'), tmp));
  const platform = await build(productionBundle(entryFor('angular-platform-browser'), tmp));

  commonMeta = requiredMetafile(common, 'angular-common');
  platformMeta = requiredMetafile(platform, 'angular-platform-browser');
});

afterAll(() => {
  if (tmp) {
    rmSync(tmp, {recursive: true, force: true});
  }
});

describe('Angular-core identity regression suite', () => {
  it('yields identical @angular/core class identity across two consumer bundles', () => {
    const a = loadNativeModule(join(tmp, 'consumer-a.js')) as Record<string, unknown>;
    const b = loadNativeModule(join(tmp, 'consumer-b.js')) as Record<string, unknown>;

    expect(typeof a.InjectionToken).toBe('function');
    expect(a.InjectionToken).toBe(b.InjectionToken);
  });

  it('never inlines @angular/core into either consumer bundle', () => {
    expect(bundledShared(consumerAMeta, sharedSpecifiers())).not.toContain('@angular/core');
    expect(bundledShared(consumerBMeta, sharedSpecifiers())).not.toContain('@angular/core');
  });

  it('never inlines @angular/core into angular-common or angular-platform-browser', () => {
    expect(bundledShared(commonMeta, ['@angular/core'])).not.toContain('@angular/core');
    expect(bundledShared(platformMeta, ['@angular/core'])).not.toContain('@angular/core');
  });
});
