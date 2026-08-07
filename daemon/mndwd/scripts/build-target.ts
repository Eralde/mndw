import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';

import type {ProductTarget} from '../../../build/targets.js';

export interface GoTargetConfig {
  readonly GOARCH: string;
  readonly GOARM?: string;
  readonly GOMIPS?: string;
}

export const GO_TARGETS: Record<ProductTarget, GoTargetConfig> = {
  'mipsel-3.4': {GOARCH: 'mipsle', GOMIPS: 'softfloat'},
  'aarch64-3.10': {GOARCH: 'arm64'},
  'armv7-3.2': {GOARCH: 'arm', GOARM: '7'},
};

export function goTargetEnvironment(repoRoot: string, target: ProductTarget): NodeJS.ProcessEnv {
  const config = GO_TARGETS[target];

  return {
    ...process.env,
    ...config,
    GOOS: 'linux',
    CGO_ENABLED: '0',
    GOCACHE: process.env.GOCACHE ?? join(repoRoot, '.cache/go-build'),
  };
}

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
    '-o',
    options.outputPath,
    '-ldflags',
    `-X main.version=${options.version}`,
    './cmd/mndwd',
  ], {
    cwd: daemonDir,
    env: goTargetEnvironment(options.repoRoot, options.target),
    stdio: 'inherit',
  });

  if (result.error || result.status !== 0) {
    throw new Error(`go build failed for target ${options.target}`);
  }
}
