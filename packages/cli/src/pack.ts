import {spawnSync} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';

import {type PluginManifestOutput} from '@mndw/sdk';
import {pluginDependencies} from '@mndw/sdk/shared-dependencies';
import {build} from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import vuePlugin from 'unplugin-vue/esbuild';

import {type AngularCompileResult, compileAngular} from './angular-compiler.js';
import {CliError} from './errors.js';
import {type PluginFramework, detectFramework} from './framework.js';
import {buildLock, findBundledSharedDependencies, serializeLock} from './lock.js';
import {readManifest} from './manifest.js';
import {resolvePluginDir} from './paths.js';

/**
 * The CLI's own `node_modules`, used as an esbuild resolution fallback so a plugin's bundled runtime
 * (e.g. the Svelte compiler output importing `svelte/internal/*`) resolves against the CLI's pinned
 * versions regardless of where the plugin source lives — the packer, not the plugin, owns them.
 */
const CLI_NODE_MODULES = resolve(import.meta.dirname, '..', 'node_modules');

export interface PackOptions {
  /** Output directory. Defaults to `<plugin-dir>/dist`. */
  readonly outDir?: string;
}

export interface PackResult {
  readonly outDir: string;
  readonly framework: PluginFramework;
  readonly manifest: PluginManifestOutput;
  readonly manifestPath: string;
  readonly entryPath: string;
}

export interface PackExamplePluginsOptions {
  /** One destination containing a subdirectory for each packed plugin. */
  readonly outDir: string;
  /** Directory containing manifest-backed plugin source directories. */
  readonly sourceDir?: string;
}

function runPluginBuild(pluginDir: string): void {
  const pkgPath = join(pluginDir, 'package.json');

  if (!existsSync(pkgPath)) {
    return;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name?: string;
    scripts?: Record<string, string>;
  };

  if (pkg.scripts?.build === undefined) {
    return;
  }

  const result = spawnSync('pnpm', ['run', 'build'], {cwd: pluginDir, stdio: 'inherit'});

  if (result.status !== 0) {
    throw new CliError(`Plugin build failed for ${pkg.name ?? pluginDir} (exit ${result.status ?? 'signal'})`);
  }
}

interface StagedAsset {
  readonly rel: string;
  readonly contents: Buffer;
  readonly mode: number;
}

/**
 * Builds a vanilla, Svelte, Vue, or Angular plugin into an isolated output directory: bundles its entry to a
 * browser ESM module at `dist/<manifest.entry>` (host-shared deps kept external), writes any emitted
 * CSS to the host-expected `dist/index.css`, re-serializes the validated `manifest.json`, and copies
 * every declared backend script and daemon hook. The build runs entirely in memory and only swaps the
 * output directory into place on success, so a failed build never leaves a partial distribution.
 */
export async function packPlugin(pluginDir: string, options: PackOptions = {}): Promise<PackResult> {
  const resolvedDir = resolvePluginDir(pluginDir);
  const {manifest} = readManifest(pluginDir);
  const framework = detectFramework(resolvedDir);
  const outDir = options.outDir === undefined ? join(resolvedDir, 'dist') : resolve(process.cwd(), options.outDir);
  const defaultOutDir = join(resolvedDir, 'dist');

  if (outDir !== defaultOutDir && pathsOverlap(resolvedDir, outDir)) {
    throw new CliError(`Output directory overlaps plugin source: ${outDir}`);
  }

  let angularCompile: AngularCompileResult | undefined;
  const entryPoint = framework === 'angular'
    ? (angularCompile = compileAngular(resolvedDir)).entryPath
    : join(resolvedDir, 'src', 'index.ts');

  try {
    const styleEntry = angularCompile === undefined ? undefined : join(angularCompile.cacheDir, 'styles.css');
    const entryPoints = styleEntry !== undefined && existsSync(styleEntry)
      ? [entryPoint, styleEntry]
      : [entryPoint];

    const result = await build({
      entryPoints,
      outdir: outDir,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      metafile: true,
      logLevel: 'silent',
      nodePaths: [CLI_NODE_MODULES, join(resolvedDir, 'node_modules')].filter((path) => existsSync(path)),
      external: pluginDependencies(framework),
      plugins: framework === 'svelte'
        ? [esbuildSvelte({compilerOptions: {css: 'external'}})]
        : framework === 'vue'
        ? [vuePlugin({sourceMap: false})]
        : [],
    });

    const jsOutput = result.outputFiles.find((file) => file.path.endsWith('.js'));

    if (jsOutput === undefined) {
      throw new CliError('esbuild produced no JavaScript bundle');
    }

    const cssOutput = result.outputFiles.find((file) => file.path.endsWith('.css'));

    // Fail before mutating output if a host-shared dependency leaked into the bundle.
    const bundledShared = findBundledSharedDependencies(result.metafile, pluginDependencies(framework));

    if (bundledShared.length > 0) {
      throw new CliError(
        `Packed bundle must not include host-shared dependencies: ${bundledShared.join(', ')}`,
      );
    }

    const lock = serializeLock(buildLock(manifest, framework));

    // Read backend assets before mutating any output, so a missing asset fails cleanly.
    const backendAssets = collectBackendAssets(manifest, resolvedDir);

    const parent = dirname(outDir);

    mkdirSync(parent, {recursive: true});

    const staging = mkdtempSync(join(parent, '.mndw-pack-'));

    try {
      writeStaged(staging, manifest.entry, Buffer.from(jsOutput.contents));

      if (cssOutput !== undefined) {
        writeStaged(staging, 'index.css', Buffer.from(cssOutput.contents));
      }

      writeStaged(staging, 'manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
      writeStaged(staging, 'mndw.lock.json', Buffer.from(lock));

      for (const asset of backendAssets) {
        writeStaged(staging, asset.rel, asset.contents, asset.mode);
      }

      promoteStaging(staging, outDir);
    } catch (error) {
      rmSync(staging, {recursive: true, force: true});

      throw error;
    }

    return {
      outDir,
      framework,
      manifest,
      manifestPath: join(outDir, 'manifest.json'),
      entryPath: join(outDir, manifest.entry),
    };
  } finally {
    angularCompile?.cleanup();
  }
}

/** Atomically replaces output where possible, restoring the prior output if promotion fails. */
function promoteStaging(staging: string, outDir: string): void {
  const backup = `${staging}.previous`;
  const hasExistingOutput = existsSync(outDir);

  if (hasExistingOutput) {
    renameSync(outDir, backup);
  }

  try {
    renameSync(staging, outDir);
  } catch (error) {
    if (hasExistingOutput) {
      renameSync(backup, outDir);
    }

    throw error;
  }

  if (hasExistingOutput) {
    rmSync(backup, {recursive: true, force: true});
  }
}

/** Packs every manifest-backed plugin directory below `sourceDir` into `outDir/<plugin-name>`. */
export async function packExamplePlugins(options: PackExamplePluginsOptions): Promise<string[]> {
  const sourceDir = resolve(process.cwd(), options.sourceDir ?? 'example-plugins');
  const outDir = resolve(process.cwd(), options.outDir);
  const names = readdirSync(sourceDir, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(sourceDir, entry.name, 'manifest.json')))
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    runPluginBuild(join(sourceDir, name));
    await packPlugin(join(sourceDir, name), {outDir: join(outDir, name)});
  }

  return names;
}

/** Relative source paths of every declared backend script and daemon hook (deduped). */
function backendAssetRelPaths(manifest: PluginManifestOutput): string[] {
  const backend = manifest.backend;

  if (backend === undefined) {
    return [];
  }

  const paths: string[] = [];

  for (const script of backend.scripts ?? []) {
    paths.push(script.source);
  }

  if (backend.daemon !== undefined) {
    paths.push(backend.daemon.start, backend.daemon.stop);
  }

  for (const asset of backend.assets ?? []) {
    paths.push(asset);
  }

  return [...new Set(paths)];
}

function collectBackendAssets(manifest: PluginManifestOutput, pluginDir: string): StagedAsset[] {
  return backendAssetRelPaths(manifest).map((rel) => {
    const source = safeJoin(pluginDir, rel);

    try {
      return {rel, contents: readFileSync(source), mode: statSync(source).mode};
    } catch {
      throw new CliError(`Missing backend asset "${rel}" declared in manifest: ${source}`);
    }
  });
}

function writeStaged(root: string, rel: string, contents: Buffer, mode?: number): void {
  const dest = safeJoin(root, rel);

  mkdirSync(dirname(dest), {recursive: true});
  writeFileSync(dest, contents);

  if (mode !== undefined) {
    chmodSync(dest, mode);
  }
}

/** Joins `rel` under `root`, rejecting any path that escapes `root`. */
function safeJoin(root: string, rel: string): string {
  const resolvedRoot = resolve(root);
  const dest = resolve(resolvedRoot, rel);

  if (dest !== resolvedRoot && !dest.startsWith(resolvedRoot + sep)) {
    throw new CliError(`Unsafe relative path escapes plugin directory: ${rel}`);
  }

  return dest;
}

/** True when either resolved path is the other or a descendant of it. */
function pathsOverlap(first: string, second: string): boolean {
  return first === second || first.startsWith(second + sep) || second.startsWith(first + sep);
}
