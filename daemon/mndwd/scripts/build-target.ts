import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {type ProductTarget, goTargetEnvironment} from '@mndw/cli/go-target';

// Keep device images within the internal flash budget; HTTPS clients then use HTTP/1.1.
export const DEVICE_DAEMON_GO_BUILD_TAG = 'nethttpomithttp2';

export interface BuildDaemonTargetOptions {
  readonly repoRoot: string;
  readonly target: ProductTarget;
  readonly outputPath: string;
  readonly version: string;
  readonly spawn?: typeof spawnSync;
}

export function buildDaemonTarget(options: BuildDaemonTargetOptions): void {
  const daemonDir = join(options.repoRoot, 'daemon', 'mndwd');

  if (!existsSync(join(daemonDir, 'go.mod'))) {
    throw new Error('daemon/mndwd/go.mod not found');
  }

  mkdirSync(dirname(options.outputPath), {recursive: true});

  const result = (options.spawn ?? spawnSync)('go', [
    'build',
    '-tags',
    DEVICE_DAEMON_GO_BUILD_TAG,
    '-o',
    options.outputPath,
    '-ldflags',
    `-s -w -X main.version=${options.version}`,
    './cmd/mndwd',
  ], {
    cwd: daemonDir,
    env: {
      ...goTargetEnvironment(options.target),
      GOWORK: 'off',
      GOCACHE: process.env.GOCACHE ?? join(options.repoRoot, '.cache/go-build'),
    },
    stdio: 'inherit',
  });

  if (result.error || result.status !== 0) {
    throw new Error(`go build failed for target ${options.target}`);
  }
}
