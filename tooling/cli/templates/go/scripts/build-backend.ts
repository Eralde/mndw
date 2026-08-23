import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildGoBackend} from '@mndw/cli/go-backend';
import {type ProductTarget, isProductTarget} from '@mndw/cli/go-target';

const plugin = '__MNDW_NAME__';
const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend');

function parseOptions(): {target: ProductTarget; outDir: string} | null {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

  if (args.includes('--')) {
    throw new Error('build-backend does not accept leaked -- separators');
  }

  if (args.length === 0) {
    return null;
  }

  if (args.length !== 4 || args[0] !== '--target' || args[2] !== '--out-dir') {
    throw new Error('build-backend accepts either no arguments or --target <target> --out-dir <dir>');
  }

  const target = args[1];
  const outDir = args[3];

  if (target === undefined || outDir === undefined || !isProductTarget(target)) {
    throw new Error(`unknown product target: ${target ?? ''}`);
  }

  if (outDir.length === 0) {
    throw new Error('--out-dir must be a non-empty path');
  }

  return {target, outDir};
}

function main(): void {
  const options = parseOptions();

  buildGoBackend({
    plugin,
    backendDir,
    binaryName: '__MNDW_NAME__d',
    entryPackage: './cmd/__MNDW_NAME__d',
    target: options?.target,
    outDir: options?.outDir,
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
