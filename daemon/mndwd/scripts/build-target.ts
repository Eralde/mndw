import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {type GoTargetConfig, PRODUCT_TARGET_CONFIG, type ProductTarget} from '../../../build/targets.js';

export const GO_TARGETS: Record<ProductTarget, GoTargetConfig> = {
  aarch64: PRODUCT_TARGET_CONFIG.aarch64.go,
  mips: PRODUCT_TARGET_CONFIG.mips.go,
  mipsel: PRODUCT_TARGET_CONFIG.mipsel.go,
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
