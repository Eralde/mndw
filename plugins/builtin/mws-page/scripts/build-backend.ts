import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {GO_TARGETS, goTargetEnvironment} from '../../../../daemon/mndwd/scripts/build-target.js';

const plugin = 'mws-page';
const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const builds = [
  ['mwsd', './cmd/mwsd'],
  ['mwsd-client', './cmd/mwsd-client'],
] as const;

function parseOptions(): {target: string; outDir: string} | null {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');

  if (args.length === 0) {
    return null;
  }

  let target: string | undefined;
  let outDir: string | undefined;

  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--target') {
      target = args[++index];
    } else if (args[index] === '--out-dir') {
      outDir = args[++index];
    } else {
      throw new Error(`unknown build-backend argument: ${args[index]}`);
    }
  }

  if (target === undefined || outDir === undefined) {
    throw new Error('build-backend requires --target and --out-dir');
  }

  if (!(target in GO_TARGETS)) {
    throw new Error(`unknown product target: ${target}`);
  }

  return {target, outDir};
}

function main(): void {
  const options = parseOptions();
  const outputDir = options?.outDir ?? backendDir;

  if (options !== null) {
    mkdirSync(outputDir, {recursive: true});
  }

  const env = options === null
    ? {...process.env, CGO_ENABLED: '0'}
    : goTargetEnvironment(resolve(backendDir, '../../../..'), options.target);
  const binaries: {source: string; destination: string}[] = [];

  for (const [output, packagePath] of builds) {
    const outputPath = join(outputDir, output);
    const result = spawnSync('go', ['build', '-ldflags', '-s -w', '-o', outputPath, packagePath], {
      cwd: backendDir,
      stdio: 'inherit',
      env,
    });

    if (result.error || result.status !== 0) {
      throw new Error(`${output} build failed`);
    }

    if (options !== null) {
      binaries.push({source: output, destination: `backend/${output}`});
    }
  }

  if (options !== null) {
    writeFileSync(
      join(outputDir, 'backend-artifact.json'),
      `${
        JSON.stringify(
          {
            plugin,
            target: options.target,
            binaries,
          },
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
