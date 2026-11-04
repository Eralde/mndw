import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, it} from 'vitest';
import {SHARED_DEPENDENCIES} from '@mndw/sdk-internal/shared-dependencies';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = <T>(path: string): T => {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
};

const workspaceCatalogVersion = (): string | undefined => {
  const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const catalog = workspace.match(/^catalog:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] ?? '';

  return catalog.match(/^\s*['"]?@rci-tools\/core['"]?\s*:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1];
};

const workspacePackageJsonPaths = (): string[] => {
  const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const packages = workspace.match(/^packages:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] ?? '';
  const patterns = [...packages.matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((match) => match[1]);

  return patterns.flatMap((pattern) => {
    const wildcardIndex = pattern.indexOf('*');
    const parent = resolve(repoRoot, pattern.slice(0, wildcardIndex).replace(/\/$/, ''));

    return readdirSync(parent, {withFileTypes: true})
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name, 'package.json'))
      .filter((path) => existsSync(path));
  });
};

it('pins @rci-tools/core once, in the catalog', () => {
  expect(workspaceCatalogVersion()).toBe('0.6.0');
});

it('stamps the catalog version into shared dependencies', () => {
  const dependency = SHARED_DEPENDENCIES.find((entry) => entry.specifiers.includes('@rci-tools/core'));

  expect(dependency?.version).toBe('0.6.0');
});

it('declares the published peer range', () => {
  const sdk = readJson<{peerDependencies?: Record<string, string>}>(join(repoRoot, 'frontend/sdk/package.json'));

  expect(sdk.peerDependencies?.['@rci-tools/core']).toBe('^0.6.0');
});

it('uses no literal @rci-tools/core version outside the catalog', () => {
  const declarations = workspacePackageJsonPaths().flatMap((path) => {
    const manifest = readJson<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(path);

    return ['dependencies', 'devDependencies'].flatMap((field) => {
      const version = manifest[field as 'dependencies' | 'devDependencies']?.['@rci-tools/core'];

      return version === undefined || version === 'catalog:' ? [] : [{path, field, version}];
    });
  });

  expect(declarations).toEqual([]);
});
