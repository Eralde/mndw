import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {buildPluginBackends} from './plugin-backends.js';
import {BUILTIN_BACKEND_NAMES} from './builtin-backends.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const fixtures: string[] = [];

const makeFixture = (): {repoRoot: string; outputRoot: string} => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-plugin-backends-'));
  const builtinRoot = path.join(root, 'plugins', 'builtin');
  const outputRoot = path.join(root, 'output');

  fixtures.push(root);

  for (const [plugin, binaryName] of [['builtin-wrapper', 'mwsd'], ['fallback-plugin', 'third-party-backend']]) {
    const pluginDir = path.join(builtinRoot, plugin);

    fs.mkdirSync(pluginDir, {recursive: true});
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        mndw: {backendBuildScript: 'build-backend', backend: {binaryName}},
      }),
    );
  }

  return {repoRoot: root, outputRoot};
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, {recursive: true, force: true});
  }
});

describe('buildPluginBackends', () => {
  it('writes daemon wrappers and builds other backend binaries', () => {
    const fixture = makeFixture();
    const builtPlugins: string[] = [];
    const binaries = buildPluginBackends(fixture.repoRoot, 'aarch64', fixture.outputRoot, (options) => {
      builtPlugins.push(options.plugin);

      return {
        plugin: options.plugin,
        target: options.target,
        binaries: [{source: 'compiled-backend', destination: 'backend/compiled-backend'}],
      };
    });
    const wrapperSource = path.join(
      fixture.outputRoot,
      'opt/share/www/mndw/plugins/builtin-wrapper/mwsd',
    );

    expect(fs.readFileSync(wrapperSource, 'utf8')).toBe(
      '#!/bin/sh\nexec /opt/sbin/mndwd backend mwsd "$@"\n',
    );
    expect(fs.statSync(wrapperSource).mode.toString(8).slice(-3)).toBe('755');
    expect(builtPlugins).toEqual(['fallback-plugin']);
    expect(binaries).toEqual([
      {
        plugin: 'builtin-wrapper',
        source: wrapperSource,
        destination: 'opt/share/www/mndw/plugins/builtin-wrapper/backend/mwsd',
      },
      {
        plugin: 'fallback-plugin',
        source: path.join(fixture.outputRoot, 'opt/share/www/mndw/plugins/fallback-plugin/compiled-backend'),
        destination: 'opt/share/www/mndw/plugins/fallback-plugin/backend/compiled-backend',
      },
    ]);
  });

  it('keeps wrapper names aligned with the daemon dispatch table', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'daemon/mndwd/cmd/mndwd/backend_dispatch.go'),
      'utf8',
    );
    const daemonNames = [...source.matchAll(/^\s*\{name: "([^"]+)", main:/gm)].map((match) => match[1]).sort();

    expect([...BUILTIN_BACKEND_NAMES].sort()).toEqual(daemonNames);
  });
});
