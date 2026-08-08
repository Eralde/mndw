import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {GO_TARGETS, goTargetEnvironment} from '../../../../daemon/mndwd/scripts/build-target.js';

const plugin = 'terminal-page';
const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend');

function main(): void {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');

  if (args.length === 0) {
    return build(undefined, backendDir);
  }

  const targetIndex = args.indexOf('--target');
  const outIndex = args.indexOf('--out-dir');
  const target = args[targetIndex + 1];
  const outDir = args[outIndex + 1];

  if (target === undefined || outDir === undefined || !(target in GO_TARGETS)) {
    throw new Error('build-backend requires valid --target and --out-dir');
  }

  build(target, outDir);
}

function build(target: string | undefined, outDir: string): void {
  mkdirSync(outDir, {recursive: true});

  const env = target === undefined
    ? {...process.env, CGO_ENABLED: '0', GOWORK: 'off'}
    : {...goTargetEnvironment(resolve(backendDir, '../../../..'), target), GOWORK: 'off'};
  const output = join(outDir, 'terminal-backend');
  const result = spawnSync('go', ['build', '-ldflags', '-s -w', '-o', output, './cmd/terminal-backend'], {
    cwd: backendDir,
    stdio: 'inherit',
    env,
  });

  if (result.error || result.status !== 0) {
    throw new Error('terminal-backend build failed');
  }

  if (target !== undefined) {
    writeFileSync(
      join(outDir, 'backend-artifact.json'),
      `${
        JSON.stringify(
          {plugin, target, binaries: [{source: 'terminal-backend', destination: 'backend/terminal-backend'}]},
          null,
          2,
        )
      }\n`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
