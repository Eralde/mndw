import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {type PackedPluginArtifact, parsePackedPluginArtifact} from '@mndw/cli/packed-plugin-artifact';
import {buildBackend} from '../tooling/cli/src/backend-build.js';
import {packPlugin} from '../tooling/cli/src/pack.js';
import {readPluginPackage} from '../tooling/cli/src/plugin-package.js';
import {promoteDirectory} from '../tooling/cli/src/promote-directory.js';
import {zipDirectory} from '../tooling/cli/src/zip.js';
import {PRODUCT_TARGETS, type ProductTarget} from './targets.js';
import {verifyElfBytes} from './packaging/build-ipk.js';

export const EXAMPLE_TARGETS = PRODUCT_TARGETS;

interface ExamplePlugin {
  readonly directory: string;
  readonly name: string;
  readonly hasBackendBuildScript: boolean;
}

interface RawManifest {
  readonly name?: unknown;
}

function defaultRepoRoot(): string {
  return resolve(import.meta.dirname, '..');
}

export function discoverExamplePlugins(sourceRoot: string): ExamplePlugin[] {
  const plugins: ExamplePlugin[] = [];
  const names = new Set<string>();

  for (const entry of readdirSync(sourceRoot, {withFileTypes: true})) {
    if (!entry.isDirectory()) {
      continue;
    }

    const directory = join(sourceRoot, entry.name);
    const manifestPath = join(directory, 'manifest.json');

    if (!existsSync(manifestPath)) {
      continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RawManifest;

    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      throw new Error(`Example plugin manifest has no name: ${manifestPath}`);
    }

    if (names.has(manifest.name)) {
      throw new Error(`Duplicate example plugin name: ${manifest.name}`);
    }

    names.add(manifest.name);

    const pkg = readPluginPackage(directory);
    const buildScript = pkg?.mndw?.backendBuildScript;

    plugins.push({
      directory,
      name: manifest.name,
      hasBackendBuildScript: typeof buildScript === 'string' && buildScript.length > 0,
    });
  }

  return plugins.sort((first, second) => first.name.localeCompare(second.name));
}

export function expectedExampleArchiveNames(
  sourceRoot = join(defaultRepoRoot(), 'plugins', 'examples'),
): string[] {
  return discoverExamplePlugins(sourceRoot).flatMap((plugin) =>
    plugin.hasBackendBuildScript
      ? EXAMPLE_TARGETS.map((target) => `${plugin.name}-${target}.zip`)
      : [`${plugin.name}.zip`]
  );
}

interface ExampleBuildOptions {
  readonly repoRoot?: string;
  readonly outputRoot?: string;
}

function writeArchive(outputRoot: string, name: string, packedRoot: string): void {
  writeFileSync(join(outputRoot, name), zipDirectory(packedRoot));
}

export function verifyPackedBackend(
  packedRoot: string,
  target: ProductTarget,
  binaries: readonly {readonly destination: string}[],
): void {
  const artifactPath = join(packedRoot, 'mndw-artifact.json');
  let value: unknown;

  try {
    value = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `invalid packed plugin artifact: ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let artifact: PackedPluginArtifact;

  try {
    artifact = parsePackedPluginArtifact(value);
  } catch (error) {
    throw new Error(
      `invalid packed plugin artifact: ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const metadata = artifact.backend;

  if (metadata?.target !== target || metadata.files?.length !== binaries.length) {
    throw new Error(`packed backend metadata does not describe target ${target}`);
  }

  for (const binary of binaries) {
    const backendPath = join(packedRoot, binary.destination);
    let contents: Buffer;

    try {
      if (!statSync(backendPath).isFile()) {
        throw new Error(`packed backend is not a regular file: ${backendPath}`);
      }

      contents = readFileSync(backendPath);
    } catch (error) {
      throw new Error(
        `packed backend file unavailable for ${target}: ${backendPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (contents.subarray(0, 4).toString('ascii') === '\x7fELF') {
      verifyElfBytes(contents, target);
    }

    const digest = createHash('sha256').update(contents)
      .digest('hex');
    const file = metadata.files?.find((candidate) => candidate.path === binary.destination);

    if (file?.sha256 !== digest) {
      throw new Error(`packed backend metadata does not match injected backend for ${target}`);
    }
  }
}

export async function buildExamplePlugins(options: ExampleBuildOptions = {}): Promise<string[]> {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot());
  const outputRoot = resolve(options.outputRoot ?? join(repoRoot, 'out', 'example-plugins'));
  const sourceRoot = join(repoRoot, 'plugins', 'examples');
  const plugins = discoverExamplePlugins(sourceRoot);
  const stagingRoot = mkdtempSync(join(dirname(outputRoot), '.mndw-example-'));
  const archiveRoot = join(stagingRoot, 'archives');

  mkdirSync(archiveRoot);

  try {
    for (const plugin of plugins) {
      if (!plugin.hasBackendBuildScript) {
        const packedRoot = join(stagingRoot, `packed-${plugin.name}`);

        await packPlugin(plugin.directory, {outDir: packedRoot});
        writeArchive(archiveRoot, `${plugin.name}.zip`, packedRoot);

        continue;
      }

      for (const target of EXAMPLE_TARGETS) {
        const backendOut = join(stagingRoot, `backend-${plugin.name}-${target}`);
        const backend = buildBackend({
          pluginDir: plugin.directory,
          plugin: plugin.name,
          target,
          outDir: backendOut,
        });

        if (backend === null) {
          throw new Error(`${plugin.name} has no backend build hook`);
        }

        const packedRoot = join(stagingRoot, `packed-${plugin.name}-${target}`);

        await packPlugin(plugin.directory, {
          outDir: packedRoot,
          backendOverride: {
            target,
            sourceRoot: backendOut,
            files: backend.binaries.map((binary) => ({
              source: join(backendOut, binary.source),
              destination: binary.destination,
              mode: 0o755,
            })),
          },
        });
        verifyPackedBackend(packedRoot, target, backend.binaries);
        writeArchive(archiveRoot, `${plugin.name}-${target}.zip`, packedRoot);
      }
    }

    const names = expectedExampleArchiveNames(sourceRoot);

    promoteDirectory(archiveRoot, outputRoot);
    rmSync(stagingRoot, {recursive: true, force: true});

    return names;
  } catch (error) {
    if (existsSync(stagingRoot)) {
      rmSync(stagingRoot, {recursive: true, force: true});
    }

    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildExamplePlugins()
    .then((names) => {
      process.stdout.write(`Built example plugin archives: ${names.join(', ')}\n`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
