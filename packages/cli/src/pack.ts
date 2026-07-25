import {spawnSync} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {basename, dirname, extname, isAbsolute, join, relative, resolve, sep} from 'node:path';

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
import {readPluginPackage} from './plugin-package.js';
import {resolveDevelopmentSourceEntry, resolveProductionSourceEntry} from './source-entry.js';

/**
 * The CLI's own `node_modules`, used as an esbuild resolution fallback so a plugin's bundled runtime
 * (e.g. the Svelte compiler output importing `svelte/internal/*`) resolves against the CLI's pinned
 * versions regardless of where the plugin source lives — the packer, not the plugin, owns them.
 */
const CLI_NODE_MODULES = resolve(import.meta.dirname, '..', 'node_modules');

export interface PackOptions {
  /** Output directory. Defaults to `<plugin-dir>/dist`. */
  readonly outDir?: string;
  /** Use `src/index.ts` instead of the configured production entry. */
  readonly development?: boolean;
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
  /** Pack development entries so repository dev serves source-only behavior. */
  readonly development?: boolean;
}

function runPluginBuild(pluginDir: string): void {
  const pkg = readPluginPackage(pluginDir);

  if (pkg === null) {
    return;
  }

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
  readonly mode?: number;
}

interface WorkerReference {
  readonly outputRel: string;
  readonly runtimeSpecifier: string;
  readonly sourcePath: string;
  readonly sourceSpecifier: string;
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
  const sourceEntry = options.development
    ? resolveDevelopmentSourceEntry(resolvedDir)
    : resolveProductionSourceEntry(resolvedDir);
  const framework = detectFramework(resolvedDir);
  const outDir = options.outDir === undefined ? join(resolvedDir, 'dist') : resolve(process.cwd(), options.outDir);
  const defaultOutDir = join(resolvedDir, 'dist');

  if (outDir !== defaultOutDir && pathsOverlap(resolvedDir, outDir)) {
    throw new CliError(`Output directory overlaps plugin source: ${outDir}`);
  }

  let angularCompile: AngularCompileResult | undefined;
  const entryPoint = framework === 'angular'
    ? (angularCompile = compileAngular(resolvedDir, sourceEntry)).entryPath
    : join(resolvedDir, sourceEntry);

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

    const jsOutputs = result.outputFiles.filter((file) => file.path.endsWith('.js'));
    const jsOutput = jsOutputs.find((file) => file.path === join(outDir, 'index.js')) ?? jsOutputs[0];

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
    const workerReferences = collectWorkerReferences(resolvedDir, manifest.entry, result.metafile);
    const workerAssets = await buildWorkerAssets(workerReferences, outDir, resolvedDir, framework);
    const mainBundle = rewriteWorkerSpecifiers(jsOutput.contents, workerReferences);

    const parent = dirname(outDir);

    mkdirSync(parent, {recursive: true});

    const staging = mkdtempSync(join(parent, '.mndw-pack-'));

    try {
      writeStaged(staging, manifest.entry, mainBundle);

      if (cssOutput !== undefined) {
        writeStaged(staging, 'index.css', Buffer.from(cssOutput.contents));
      }

      writeStaged(staging, 'manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
      writeStaged(staging, 'mndw.lock.json', Buffer.from(lock));

      for (const output of jsOutputs) {
        if (output !== jsOutput) {
          const rel = relative(outDir, output.path);

          if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
            throw new CliError(`esbuild output escapes plugin directory: ${output.path}`);
          }

          writeStaged(staging, rel, Buffer.from(output.contents));
        }
      }

      for (const asset of workerAssets) {
        writeStaged(staging, asset.rel, asset.contents);
      }

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
    await packPlugin(join(sourceDir, name), {outDir: join(outDir, name), development: options.development});
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

const WORKER_URL_PATTERN = /new\s+Worker\s*\(\s*new\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;

function collectWorkerReferences(
  pluginDir: string,
  manifestEntry: string,
  metafile: {readonly inputs: Readonly<Record<string, unknown>>},
): WorkerReference[] {
  const references: WorkerReference[] = [];
  const outputOwners = new Map<string, string>();
  const resolvedPluginDir = realpathSync(pluginDir);

  for (const input of Object.keys(metafile.inputs)) {
    const inputPath = resolve(process.cwd(), input);

    if (!existsSync(inputPath)) {
      continue;
    }

    const realInputPath = realpathSync(inputPath);

    if (!isInside(resolvedPluginDir, realInputPath)) {
      continue;
    }

    const source = readFileSync(realInputPath, 'utf8');

    for (const match of source.matchAll(WORKER_URL_PATTERN)) {
      const sourceSpecifier = match[2];

      if (!sourceSpecifier?.endsWith('.worker.ts')) {
        continue;
      }

      const sourcePath = resolve(dirname(realInputPath), sourceSpecifier);

      if (!isInside(resolvedPluginDir, sourcePath)) {
        throw new CliError(`Worker source escapes plugin directory: ${sourceSpecifier}`);
      }

      if (!existsSync(sourcePath)) {
        throw new CliError(`Missing worker source: ${sourcePath}`);
      }

      const outputRel = join(dirname(manifestEntry), `${basename(sourcePath, extname(sourcePath))}.js`);
      const previousOwner = outputOwners.get(outputRel);

      if (previousOwner !== undefined && previousOwner !== sourcePath) {
        throw new CliError(`Worker output path collision: ${outputRel}`);
      }

      outputOwners.set(outputRel, sourcePath);

      const runtimePath = relative(dirname(manifestEntry), outputRel).split(sep)
        .join('/');

      if (references.some((reference) => reference.sourceSpecifier === sourceSpecifier)) {
        continue;
      }

      references.push({
        outputRel,
        runtimeSpecifier: runtimePath.startsWith('.') ? runtimePath : `./${runtimePath}`,
        sourcePath,
        sourceSpecifier,
      });
    }
  }

  return references;
}

async function buildWorkerAssets(
  references: readonly WorkerReference[],
  outDir: string,
  pluginDir: string,
  framework: PluginFramework,
): Promise<StagedAsset[]> {
  const assets: StagedAsset[] = [];
  const built = new Set<string>();

  for (const reference of references) {
    if (built.has(reference.outputRel)) {
      continue;
    }

    const result = await build({
      entryPoints: [reference.sourcePath],
      outdir: outDir,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
      nodePaths: [CLI_NODE_MODULES, join(pluginDir, 'node_modules')].filter((path) => existsSync(path)),
      external: pluginDependencies(framework),
    });
    const output = result.outputFiles.find((file) => file.path.endsWith('.js'));

    if (output === undefined) {
      throw new CliError(`esbuild produced no JavaScript bundle for worker: ${reference.sourcePath}`);
    }

    assets.push({rel: reference.outputRel, contents: Buffer.from(output.contents)});
    built.add(reference.outputRel);
  }

  return assets;
}

function rewriteWorkerSpecifiers(contents: Uint8Array, references: readonly WorkerReference[]): Buffer {
  let source = Buffer.from(contents).toString('utf8');

  for (const reference of references) {
    source = source.replaceAll(reference.sourceSpecifier, reference.runtimeSpecifier);
  }

  return Buffer.from(source);
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

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** True when either resolved path is the other or a descendant of it. */
function pathsOverlap(first: string, second: string): boolean {
  return first === second || first.startsWith(second + sep) || second.startsWith(first + sep);
}
