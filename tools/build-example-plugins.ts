/**
 * Throwaway build for Phase 4c example plugins (the real `mndw pack` CLI arrives in
 * Phase 5). Bundles each plugin's `src/index.ts` to ESM with the shared deps kept
 * external (host import map resolves them to /shared/*); svelte + d3 inline. Emits
 * `<outDir>/<name>/{index.js,index.css?,manifest.json}` for the daemon's
 * --builtin-plugins-dir.
 */
import {copyFileSync, existsSync, mkdirSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import {pluginDependencies} from '@mndw/sdk/shared-dependencies';

const EXTERNALS = pluginDependencies('svelte'); // @rci-tools/core, rxjs, rxjs/operators, hash-wasm

export interface BuildOptions {
  outDir: string;
  sourceDir?: string;
}

/** Names of dirs under sourceDir that hold a plugin (manifest.json + src/index.ts). */
function pluginNames(sourceDir: string): string[] {
  return readdirSync(sourceDir, {withFileTypes: true})
    .filter((d) => d.isDirectory() && d.name !== 'dist')
    .filter((d) => existsSync(path.join(sourceDir, d.name, 'manifest.json')))
    .map((d) => d.name)
    .sort();
}

export async function buildExamplePlugins(options: BuildOptions): Promise<string[]> {
  const sourceDir = options.sourceDir ?? path.resolve(process.cwd(), 'example-plugins');
  const names = pluginNames(sourceDir);

  for (const name of names) {
    const pluginDir = path.join(sourceDir, name);
    const outPluginDir = path.join(options.outDir, name);

    mkdirSync(outPluginDir, {recursive: true});

    await build({
      entryPoints: [path.join(pluginDir, 'src', 'index.ts')],
      outfile: path.join(outPluginDir, 'index.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      external: EXTERNALS,
      logLevel: 'warning',
      plugins: [esbuildSvelte({compilerOptions: {css: 'external'}})],
    });

    copyFileSync(path.join(pluginDir, 'manifest.json'), path.join(outPluginDir, 'manifest.json'));
  }

  return names;
}

// Direct-run entry: build into example-plugins/dist.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // this file is tools/build-example-plugins.ts → its dir's parent is the repo root.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  buildExamplePlugins({outDir: path.join(repoRoot, 'example-plugins', 'dist')})
    .then((names) => console.log(`Built ${names.length} example plugins:`, names.join(', ')))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
