import fs from 'node:fs';
import path from 'node:path';
import {SHARED_DEPENDENCIES} from '@mndw/sdk-internal/shared-dependencies';
import type {BuildOptions} from 'esbuild';
import {build} from 'esbuild';

// Builds the host-provided shared-dependency bundles into a selected directory, one versioned
// file per entry (`<bundle>@<version>.js`) matching the import map the host injects.
// All frameworks' bundles ship (base + vue + angular). The Angular identity invariant is encoded by
// SHARED_DEPENDENCIES and must not be changed here.
function outputDirectory(args: readonly string[]): string {
  const outIndex = args.indexOf('--out');

  if (outIndex === -1) {
    return path.resolve(import.meta.dirname, '..', 'dist', 'shared');
  }

  const outPath = args[outIndex + 1];

  if (outPath === undefined || outPath.startsWith('--')) {
    throw new Error('Expected a directory after --out');
  }

  return path.resolve(process.cwd(), outPath);
}

const outDir = outputDirectory(process.argv.slice(2));

async function bundleShared(): Promise<void> {
  fs.mkdirSync(outDir, {recursive: true});

  const entries = SHARED_DEPENDENCIES;

  await Promise.all(entries.map((entry) => {
    const options: BuildOptions = {
      bundle: true,
      format: 'esm',
      outfile: path.join(outDir, `${entry.bundle}@${entry.version}.js`),
      platform: 'browser',
      target: 'es2022',
      minify: true,
      external: entry.external,
    };

    if (entry.stdin !== undefined) {
      options.stdin = {contents: entry.stdin, resolveDir: process.cwd(), loader: 'ts'};
    } else {
      options.entryPoints = [entry.entryPoint!];
    }

    if (entry.banner !== undefined) {
      options.banner = {js: entry.banner};
    }

    return build(options);
  }));

  console.log(`Built ${entries.length} shared bundles in ${path.relative(process.cwd(), outDir)}/`);
}

bundleShared().catch((err: unknown) => {
  console.error('Failed to bundle shared externals:', err);
  process.exit(1);
});
