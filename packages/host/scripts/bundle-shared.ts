import fs from 'node:fs';
import path from 'node:path';
import {SHARED_DEPENDENCIES} from '@mndw/sdk/shared-dependencies';
import type {BuildOptions} from 'esbuild';
import {build} from 'esbuild';

// Builds the host-provided shared-dependency bundles into dist/shared, one versioned
// file per entry (`<bundle>@<version>.js`) matching the import map the host injects.
// Phase 7a ships base + vue; the angular bundles land in 7b (their deps aren't installed yet).
const outDir = path.resolve(import.meta.dirname, '..', 'dist', 'shared');

async function bundleShared(): Promise<void> {
  fs.mkdirSync(outDir, {recursive: true});

  const entries = SHARED_DEPENDENCIES.filter(
    (entry) => entry.framework === 'base' || entry.framework === 'vue',
  );

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

  console.log(`Built ${entries.length} shared bundles in dist/shared/`);
}

bundleShared().catch((err: unknown) => {
  console.error('Failed to bundle shared externals:', err);
  process.exit(1);
});
