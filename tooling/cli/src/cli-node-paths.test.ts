import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {cliNodePaths, packNodePaths} from './cli-node-paths.js';

describe('cliNodePaths', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, {recursive: true, force: true});
      root = undefined;
    }
  });

  it('walks nearest-first and skips levels without node_modules', () => {
    root = mkdtempSync(join(tmpdir(), 'mndw-cli-node-paths-'));

    const cliRoot = join(root, 'a', 'node_modules', '@mndw', 'cli');
    const nearest = join(cliRoot, 'node_modules');
    const outer = join(root, 'a', 'node_modules');

    mkdirSync(nearest, {recursive: true});
    writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({name: '@mndw/cli'}));

    expect(cliNodePaths(cliRoot).slice(0, 2)).toEqual([nearest, outer]);
    expect(cliNodePaths(cliRoot)).not.toContain(join(root, 'a', 'node_modules', '@mndw', 'node_modules'));
  });
});

describe('packNodePaths', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, {recursive: true, force: true});
      root = undefined;
    }
  });

  it('deduplicates npm flat-layout node_modules while preferring the plugin path', () => {
    root = mkdtempSync(join(tmpdir(), 'mndw-cli-npm-flat-'));

    const cliRoot = join(root, 'proj', 'node_modules', '@mndw', 'cli');
    const pluginRoot = join(root, 'proj', 'demo');
    const pluginModules = join(pluginRoot, 'node_modules');
    const sharedModules = join(root, 'proj', 'node_modules');

    mkdirSync(pluginModules, {recursive: true});
    mkdirSync(cliRoot, {recursive: true});
    writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({name: '@mndw/cli'}));

    const paths = packNodePaths(pluginRoot, cliRoot);

    expect(paths.slice(0, 2)).toEqual([pluginModules, sharedModules]);
    expect(paths.filter((path) => path === sharedModules)).toHaveLength(1);
  });

  it('puts a disjoint plugin node_modules chain before a global CLI chain', () => {
    root = mkdtempSync(join(tmpdir(), 'mndw-cli-global-'));

    const pluginRoot = join(root, 'p', 'demo');
    const pluginModules = join(pluginRoot, 'node_modules');
    const pluginParentModules = join(root, 'p', 'node_modules');
    const cliRoot = join(root, 'g', 'lib', 'node_modules', '@mndw', 'cli');

    mkdirSync(pluginModules, {recursive: true});
    mkdirSync(pluginParentModules, {recursive: true});
    mkdirSync(cliRoot, {recursive: true});
    writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({name: '@mndw/cli'}));

    const cliChain = cliNodePaths(cliRoot);
    const expected = [...new Set([...cliNodePaths(pluginRoot), ...cliChain])];

    expect(packNodePaths(pluginRoot, cliRoot)).toEqual(expected);
    expect(expected.slice(0, 2)).toEqual([pluginModules, pluginParentModules]);
    expect(expected.indexOf(cliChain[0] ?? '')).toBeGreaterThan(expected.indexOf(pluginParentModules));
  });
});
