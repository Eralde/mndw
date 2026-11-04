import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  assertBackendBinary,
  backendSmokeOutputDir,
  buildPackageManagerManifest,
  commandVersionArguments,
  fetchUiSvelteImportGraph,
  localeCatalogPaths,
  packageManagerArgs,
  yarnBerryConfig,
  yarnBerryNeedsLockBoundary,
} from './fresh-project-smoke.js';

describe('buildPackageManagerManifest', () => {
  const tarballs = {
    '@mndw/cli': '/tmp/mndw-cli.tgz',
    '@mndw/sdk': '/tmp/mndw-sdk.tgz',
    '@mndw/ui-svelte': '/tmp/mndw-ui-svelte.tgz',
  };

  it('uses file dependencies and npm overrides for the requested direct packages', () => {
    const manifest = buildPackageManagerManifest('npm', tarballs, ['@mndw/cli']);

    expect(manifest.dependencies).toEqual({'@mndw/cli': 'file:/tmp/mndw-cli.tgz'});
    expect(manifest.overrides).toEqual({
      '@mndw/cli': 'file:/tmp/mndw-cli.tgz',
      '@mndw/sdk': 'file:/tmp/mndw-sdk.tgz',
      '@mndw/ui-svelte': 'file:/tmp/mndw-ui-svelte.tgz',
    });
  });

  it('writes package-manager-specific dependency overrides', () => {
    const pnpm = buildPackageManagerManifest('pnpm', tarballs, ['@mndw/cli']);
    const yarn = buildPackageManagerManifest('yarn', tarballs, ['@mndw/cli']);

    expect(pnpm.pnpm).toEqual({overrides: expect.objectContaining({'@mndw/sdk': 'file:/tmp/mndw-sdk.tgz'})});
    expect(yarn.resolutions).toEqual(expect.objectContaining({'@mndw/ui-svelte': 'file:/tmp/mndw-ui-svelte.tgz'}));
  });
});

describe('commandVersionArguments', () => {
  it('uses go version for Go and --version for package managers', () => {
    expect(commandVersionArguments('go')).toEqual(['version']);
    expect(commandVersionArguments('npm')).toEqual(['--version']);
  });
});

describe('packageManagerArgs', () => {
  it('omits deprecated non-interactive option for Yarn Berry but keeps it for Classic', () => {
    expect(packageManagerArgs('yarn', '4.9.2')).toEqual(['install']);
    expect(packageManagerArgs('yarn', '1.22.22')).toEqual(['install', '--non-interactive']);
    expect(packageManagerArgs('npm')).toEqual(['install', '--no-audit', '--no-fund']);
  });
});

describe('Go backend smoke paths', () => {
  it('keeps build output beside the demo, outside demo/dist', () => {
    expect(backendSmokeOutputDir('/tmp/mndw-smoke', 'aarch64')).toBe('/tmp/mndw-smoke/backend-aarch64');
  });

  it('requires the expected backend binary to exist as a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mndw-backend-smoke-test-'));
    const binary = join(root, 'demo-go');

    try {
      await writeFile(binary, 'backend');
      await expect(assertBackendBinary(binary)).resolves.toBeUndefined();
      await expect(assertBackendBinary(join(root, 'missing'))).rejects.toThrow('backend binary is missing');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

describe('yarnBerryConfig', () => {
  it('enables node-modules for Berry and leaves Classic unchanged', () => {
    expect(yarnBerryConfig('4.9.2')).toBe('nodeLinker: node-modules\n');
    expect(yarnBerryConfig('1.22.22')).toBe('');
    expect(yarnBerryNeedsLockBoundary('4.9.2')).toBe(true);
    expect(yarnBerryNeedsLockBoundary('1.22.22')).toBe(false);
  });
});

describe('localeCatalogPaths', () => {
  it('returns declared locale catalogs and skips manifests without locales', () => {
    expect(localeCatalogPaths({i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'}}}))
      .toEqual(['i18n/en.json', 'i18n/ru.json']);
    expect(localeCatalogPaths({name: 'demo'})).toEqual([]);
  });
});

describe('fetchUiSvelteImportGraph', () => {
  it('follows the optimized Vite dependency entry to its actual chunk', async () => {
    const origin = 'http://127.0.0.1:5173';
    const appUrl = `${origin}/src/App.svelte`;
    const modules = new Map([
      [`${origin}/node_modules/.vite/deps/@mndw_ui-svelte.js?v=1`, 'export {MndwCell} from "./chunk-ABC.js?v=1";'],
      [`${origin}/node_modules/.vite/deps/chunk-ABC.js?v=1`, 'export const MndwCell = () => "compiled";'],
    ]);
    const requested: string[] = [];

    const graph = await fetchUiSvelteImportGraph(
      appUrl,
      'import {MndwCell} from "/node_modules/.vite/deps/@mndw_ui-svelte.js?v=1"; export {MndwCell};',
      (url) => {
        requested.push(url);

        const body = modules.get(url);

        return Promise.resolve({status: body === undefined ? 404 : 200, text: () => Promise.resolve(body ?? '')});
      },
    );

    expect(requested).toEqual([...modules.keys()]);
    expect(graph.map((module) => module.url)).toEqual([...modules.keys()]);
    expect(graph.map((module) => module.body).join('\n')).not.toContain('$state(');
  });

  it('rejects a failed request to the imported wrapper module', async () => {
    await expect(fetchUiSvelteImportGraph(
      'http://127.0.0.1:5173/src/App.svelte',
      'import {MndwCell} from "/node_modules/.vite/deps/@mndw_ui-svelte.js?v=1";',
      () => Promise.resolve({status: 504, text: () => Promise.resolve('Outdated Optimize Dep')}),
    )).rejects.toThrow('504');
  });

  it('ignores the Svelte runtime warning string for compiled state proxies', async () => {
    const origin = 'http://127.0.0.1:5173';
    const entryUrl = `${origin}/node_modules/.vite/deps/@mndw_ui-svelte.js?v=1`;
    const chunkUrl = `${origin}/node_modules/.vite/deps/chunk-ABC.js?v=1`;
    const modules = new Map([
      [entryUrl, 'export {svelteCell} from "./chunk-ABC.js?v=1";'],
      [chunkUrl, 'export const warning = "Reactive `$state(...)` proxies have different identities";'],
    ]);

    await expect(fetchUiSvelteImportGraph(
      `${origin}/src/App.svelte`,
      'import {svelteCell} from "/node_modules/.vite/deps/@mndw_ui-svelte.js?v=1";',
      (url) => {
        const body = modules.get(url);

        return Promise.resolve({status: body === undefined ? 404 : 200, text: () => Promise.resolve(body ?? '')});
      },
    )).resolves.toHaveLength(2);
  });

  it.each(['$state', '$derived', '$effect', '$props'])('rejects an executable uncompiled `%s` call', async (rune) => {
    await expect(fetchUiSvelteImportGraph(
      'http://127.0.0.1:5173/src/App.svelte',
      'import {svelteCell} from "/node_modules/.vite/deps/@mndw_ui-svelte.js?v=1";',
      (url) => {
        const body = url.includes('@mndw_ui-svelte')
          ? 'export {svelteCell} from "./chunk-ABC.js?v=1";'
          : `export const svelteCell = () => ${rune}({row: 1});`;

        return Promise.resolve({status: 200, text: () => Promise.resolve(body)});
      },
    )).rejects.toThrow('uncompiled Svelte rune');
  });
});
