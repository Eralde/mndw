import {createServer} from 'node:http';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

import {describe, expect, it, vi} from 'vitest';

import {createReloadSentinel, restartService} from './dev-reload.js';
import {type BackendWatchOptions, watchPluginBackend} from './dev.js';

function backendFixture(): {root: string; pluginDir: string; sourcePath: string} {
  const root = mkdtempSync(join(tmpdir(), 'mndw-backend-integration-'));
  const pluginDir = join(root, 'plugin');
  const backendDir = join(pluginDir, 'backend');
  const sourcePath = join(backendDir, 'cmd', 'service', 'main.go');

  mkdirSync(join(backendDir, 'cmd', 'service'), {recursive: true});
  writeFileSync(join(backendDir, 'go.mod'), 'module example.test/backend\n\ngo 1.22\n');
  writeFileSync(sourcePath, 'package main\n\nfunc main() {}\n');

  return {root, pluginDir, sourcePath};
}

function serviceManifest(): BackendWatchOptions['manifest'] {
  return {
    name: 'integration-plugin',
    backend: {
      kind: 'service',
      protocolVersion: 1,
      command: 'backend/service',
      routes: [{id: 'status', transport: 'http', method: 'GET', path: 'status'}],
    },
  } as unknown as BackendWatchOptions['manifest'];
}

describe('backend development watch integration', () => {
  it('builds Go, waits for restart HTTP 200, then writes the sentinel', async () => {
    if (spawnSync('go', ['version'], {stdio: 'ignore'}).status !== 0) {
      console.warn('Skipping backend watch integration: Go toolchain unavailable');

      return;
    }

    vi.stubEnv('CHOKIDAR_USEPOLLING', '1');
    const fixture = backendFixture();
    const sentinel = createReloadSentinel(fixture.root);
    const restartServiceSpy = vi.fn(restartService);
    const requests: string[] = [];
    let releaseRestart: (() => void) | undefined;
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');

      setTimeout(() => {
        response.statusCode = 200;
        response.end();
        releaseRestart?.();
      }, 100);
    });

    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen());
    });

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const restartHandled = new Promise<void>((resolveRestart) => {
      releaseRestart = resolveRestart;
    });
    const before = readFileSync(sentinel.path, 'utf8');
    const watcher = watchPluginBackend({
      manifest: serviceManifest(),
      pluginSourceDir: fixture.pluginDir,
      pluginName: 'integration-plugin',
      daemonUrl: `http://127.0.0.1:${port}`,
    }, {
      touchSentinel: () => sentinel.touch(),
      restartService: restartServiceSpy,
    });

    try {
      await new Promise((resolveReady) => setTimeout(resolveReady, 500));
      const temporarySource = join(fixture.pluginDir, 'backend', '.editor.tmp');

      writeFileSync(temporarySource, 'package main\n\nfunc main() { println("v2") }\n');
      renameSync(temporarySource, fixture.sourcePath);

      await vi.waitFor(() => expect(requests).toContain('/api/mgmt/restart'), {timeout: 30_000, interval: 100});
      expect(readFileSync(sentinel.path, 'utf8')).toBe(before);
      await restartHandled;
      await vi.waitFor(() => expect(readFileSync(sentinel.path, 'utf8')).toBe('1\n'), {
        timeout: 30_000,
        interval: 100,
      });
      expect(existsSync(join(fixture.pluginDir, 'backend', 'service'))).toBe(true);
      expect(restartServiceSpy).toHaveBeenCalledTimes(1);
    } finally {
      await watcher.close();
      sentinel.cleanup();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(fixture.root, {recursive: true, force: true});
      vi.unstubAllEnvs();
    }
  }, 60_000);
});
