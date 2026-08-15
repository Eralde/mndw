import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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

import {isMndwButtonA11yWarning} from '../../../build/svelte-compiler-options.js';
import {type AngularCompileResult, compileAngular} from './angular-compiler.js';
import {CliError} from './errors.js';
import {type PluginFramework, detectFramework} from './framework.js';
import {buildLock, findBundledSharedDependencies, serializeLock} from './lock.js';
import {readManifest} from './manifest.js';
import {validatePluginCatalogs} from './i18n-validator.js';
import {resolvePluginDir} from './paths.js';
import {readPluginPackage} from './plugin-package.js';
import {promoteDirectory} from './promote-directory.js';
import {resolveDevelopmentSourceEntry, resolveProductionSourceEntry} from './source-entry.js';
import type {ProductTarget} from '../../../build/targets.js';

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
  /** Replace manifest-declared backend files with binaries built for one product target. */
  readonly backendOverride?: BackendOverride;
}

export interface BackendOverride {
  readonly target: ProductTarget;
  readonly sourceRoot: string;
  readonly files: readonly {
    readonly source: string;
    readonly destination: string;
    readonly mode?: number;
  }[];
}

export interface PackResult {
  readonly outDir: string;
  readonly framework: PluginFramework;
  readonly manifest: PluginManifestOutput;
  readonly manifestPath: string;
  readonly entryPath: string;
  readonly warnings: readonly string[];
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
 * CSS to the host-expected `dist/index.css`, stages module workers referenced by plugin or bundled SDK
 * source, re-serializes the validated `manifest.json`, and copies every declared backend command.
 * The build runs entirely in memory and only swaps the output directory into place on
 * success, so a failed build never leaves a partial distribution.
 */
export async function packPlugin(pluginDir: string, options: PackOptions = {}): Promise<PackResult> {
  const resolvedDir = resolvePluginDir(pluginDir);
  const {manifest} = readManifest(pluginDir);
  const warnings = validatePluginCatalogs(resolvedDir, manifest, {strict: false});
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
        ? [
          esbuildSvelte({
            compilerOptions: {
              css: 'external',
              warningFilter: (warning) => !isMndwButtonA11yWarning(warning),
            },
          }),
        ]
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

    // Read backend commands before mutating output, so missing commands fail cleanly.
    const backendAssets = options.backendOverride === undefined
      ? collectBackendAssets(manifest, resolvedDir)
      : collectBackendOverrideAssets(manifest, options.backendOverride);
    const backendMetadata = options.backendOverride === undefined
      ? undefined
      : {
        target: options.backendOverride.target,
        files: backendAssets.map((asset) => ({
          path: asset.rel,
          sha256: createHash('sha256').update(asset.contents)
            .digest('hex'),
        })),
      };
    const catalogAssets = collectCatalogAssets(manifest, resolvedDir);
    const workerReferences = collectWorkerReferences(manifest.entry, result.metafile);
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
      writeStaged(
        staging,
        'mndw-artifact.json',
        Buffer.from(`${
          JSON.stringify(
            {
              schemaVersion: 1,
              plugin: manifest.name,
              entry: manifest.entry,
              staticBackends: backendAssetRelPaths(manifest),
              ...(backendMetadata === undefined ? {} : {backend: backendMetadata}),
            },
            null,
            2,
          )
        }\n`),
      );

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

      for (const asset of catalogAssets) {
        writeStaged(staging, asset.rel, asset.contents);
      }

      promoteDirectory(staging, outDir);
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
      warnings,
    };
  } finally {
    angularCompile?.cleanup();
  }
}

/** Packs every manifest-backed plugin directory below `sourceDir` into `outDir/<plugin-name>`. */
export async function packExamplePlugins(options: PackExamplePluginsOptions): Promise<string[]> {
  const sourceDir = resolve(process.cwd(), options.sourceDir ?? 'plugins/examples');
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

/** Relative source paths of every declared v3 backend command (deduped). */
function backendAssetRelPaths(manifest: PluginManifestOutput): string[] {
  const backend = manifest.backend;

  if (backend === undefined) {
    return [];
  }

  const paths: string[] = [];

  if (backend.kind === 'exec') {
    for (const route of backend.routes) {
      paths.push(route.command);
    }
  } else {
    paths.push(backend.command);
  }

  return [...new Set(paths)];
}

const WORKER_URL_PATTERN = /new\s+Worker\s*\(\s*new\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;

/** Finds module-worker references in every bundled source input, including workspace dependencies such as the SDK. */
function collectWorkerReferences(
  manifestEntry: string,
  metafile: {readonly inputs: Readonly<Record<string, unknown>>},
): WorkerReference[] {
  const references: WorkerReference[] = [];
  const outputOwners = new Map<string, string>();

  for (const input of Object.keys(metafile.inputs)) {
    const inputPath = resolve(process.cwd(), input);

    if (!existsSync(inputPath)) {
      continue;
    }

    const realInputPath = realpathSync(inputPath);
    const source = readFileSync(realInputPath, 'utf8');

    for (const match of source.matchAll(WORKER_URL_PATTERN)) {
      const sourceSpecifier = match[2];

      if (!sourceSpecifier?.endsWith('.worker.ts')) {
        continue;
      }

      const sourcePath = resolve(dirname(realInputPath), sourceSpecifier);

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

      if (references.some((reference) => reference.sourcePath === sourcePath)) {
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

function collectBackendAssets(
  manifest: PluginManifestOutput,
  pluginDir: string,
): StagedAsset[] {
  return backendAssetRelPaths(manifest).map((rel) => {
    const source = safeJoin(pluginDir, rel);

    try {
      const stat = statSync(source);

      if (!stat.isFile()) {
        throw new CliError(`Backend command is not a regular file: ${source}`);
      }

      return {rel, contents: readFileSync(source), mode: 0o755};
    } catch {
      throw new CliError(`Missing backend asset "${rel}" declared in manifest: ${source}`);
    }
  });
}

function collectBackendOverrideAssets(
  manifest: PluginManifestOutput,
  override: BackendOverride,
): StagedAsset[] {
  const declared = new Set(backendAssetRelPaths(manifest));
  const destinations = new Set<string>();
  const sourceRoot = resolve(override.sourceRoot);

  if (declared.size === 0) {
    throw new CliError(`Backend override supplied for plugin without a declared backend: ${manifest.name}`);
  }

  const assets = override.files.map((file) => {
    if (destinations.has(file.destination)) {
      throw new CliError(`Duplicate target backend destination: ${file.destination}`);
    }

    if (!declared.has(file.destination)) {
      throw new CliError(`Target backend destination is not declared in manifest: ${file.destination}`);
    }

    const source = resolve(file.source);
    const sourceRelative = relative(sourceRoot, source);

    if (
      sourceRelative.startsWith('..')
      || isAbsolute(sourceRelative)
      || !existsSync(source)
      || !statSync(source).isFile()
    ) {
      throw new CliError(`Target backend source is outside its build output: ${source}`);
    }

    destinations.add(file.destination);

    return {
      rel: file.destination,
      contents: readFileSync(source),
      mode: file.mode ?? 0o755,
    };
  });

  for (const destination of declared) {
    if (!destinations.has(destination)) {
      throw new CliError(`Target backend override is missing declared destination: ${destination}`);
    }
  }

  return assets;
}

function collectCatalogAssets(
  manifest: PluginManifestOutput,
  pluginDir: string,
): StagedAsset[] {
  if (manifest.i18n === undefined) {
    return [];
  }

  return Object.values(manifest.i18n.locales).map((rel) => {
    const source = safeJoin(pluginDir, rel);

    try {
      const stat = statSync(source);

      if (!stat.isFile()) {
        throw new CliError(`Catalog is not a regular file: ${source}`);
      }

      return {rel, contents: readFileSync(source)};
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }

      throw new CliError(`Missing catalog declared in manifest: ${source}`);
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
