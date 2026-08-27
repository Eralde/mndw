import {mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, it, vi} from 'vitest';

import {buildBackend, buildFrontend} from '../builtin-plugins.js';
import {watchBuiltinPlugins} from './dev.js';

function fixture(): {root: string; sourceRoot: string; distRoot: string; pluginDir: string} {
  const root = mkdtempSync(join(tmpdir(), 'mndw-builtin-integration-'));
  const sourceRoot = join(root, 'plugins', 'builtin');
  const distRoot = join(sourceRoot, 'dist');
  const pluginDir = join(sourceRoot, 'integration-page');

  mkdirSync(join(pluginDir, 'src'), {recursive: true});
  mkdirSync(join(pluginDir, 'backend'), {recursive: true});
  writeFileSync(join(pluginDir, 'src', 'index.ts'), 'export const marker = \'frontend-v1\';\n');
  writeFileSync(join(pluginDir, 'backend', 'service'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({name: '@mndw/integration-page', version: '1.0.0'}));
  writeFileSync(
    join(pluginDir, 'manifest.json'),
    JSON.stringify({
      manifestVersion: 1,
      name: 'integration-page',
      version: '1.0.0',
      type: 'page',
      label: 'Integration page',
      route: '/integration-page',
      entry: 'index.js',
      backend: {
        kind: 'service',
        protocolVersion: 1,
        command: 'backend/service',
        routes: [{id: 'health', transport: 'http', method: 'GET', path: 'health'}],
      },
    }),
  );

  return {root, sourceRoot, distRoot, pluginDir};
}

function atomicWrite(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.tmp`;

  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, filePath);
}

describe('builtin development watch integration', () => {
  it('rebuilds frontend and backend artifacts through real chokidar and pack commands', async () => {
    vi.stubEnv('CHOKIDAR_USEPOLLING', '1');

    const testFixture = fixture();
    const touchSentinel = vi.fn();
    const backendBuilder = vi.fn(() => Promise.resolve());
    const frontendWatcher = watchBuiltinPlugins({
      sourceRoot: testFixture.sourceRoot,
      distRoot: testFixture.distRoot,
      pluginNames: ['integration-page'],
      daemonUrl: 'http://daemon.test',
    }, {
      buildFrontend: (name) =>
        buildFrontend(name, {
          sourceRoot: testFixture.sourceRoot,
          distRoot: testFixture.distRoot,
          development: true,
        }),
      buildBackend: backendBuilder,
      touchSentinel,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      atomicWrite(join(testFixture.pluginDir, 'src', 'index.ts'), 'export const marker = \'frontend-v2\';\n');
      await vi.waitFor(() => expect(touchSentinel).toHaveBeenCalledTimes(1), {timeout: 30_000, interval: 100});

      expect(backendBuilder).not.toHaveBeenCalled();
      expect(readFileSync(join(testFixture.distRoot, 'integration-page', 'index.js'), 'utf8')).toContain('frontend-v2');
    } finally {
      await frontendWatcher.close();
    }

    const restartService = vi.fn(() => Promise.resolve(true));
    const frontendBuilder = vi.fn(() => Promise.resolve());
    const backendWatcher = watchBuiltinPlugins({
      sourceRoot: testFixture.sourceRoot,
      distRoot: testFixture.distRoot,
      pluginNames: ['integration-page'],
      daemonUrl: 'http://daemon.test',
    }, {
      buildFrontend: frontendBuilder,
      buildBackend: (name) =>
        buildBackend(name, {
          sourceRoot: testFixture.sourceRoot,
          distRoot: testFixture.distRoot,
          development: true,
        }),
      restartService,
      touchSentinel,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      atomicWrite(join(testFixture.pluginDir, 'backend', 'service'), '#!/bin/sh\nexit 1\n');
      await vi.waitFor(() => expect(touchSentinel).toHaveBeenCalledTimes(2), {timeout: 30_000, interval: 100});

      expect(frontendBuilder).not.toHaveBeenCalled();
      expect(restartService).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(testFixture.distRoot, 'integration-page', 'backend', 'service'), 'utf8'))
        .toContain('exit 1');
    } finally {
      await backendWatcher.close();
      rmSync(testFixture.root, {recursive: true, force: true});
      vi.unstubAllEnvs();
    }
  }, 60_000);
});
