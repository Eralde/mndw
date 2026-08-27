import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  type ArtifactDescriptor,
  type SharedArtifacts,
  readArtifactDescriptor,
  validateArtifactDescriptor,
  writeArtifactDescriptor,
} from './artifacts/descriptor.js';
import {buildDaemonTarget} from '../daemon/mndwd/scripts/build-target.js';
import {buildPluginBackends} from './plugin-backends.js';
import {PRODUCT_TARGETS, type ProductTarget, isProductTarget} from './targets.js';

export interface BuiltPluginBinary {
  readonly plugin: string;
  readonly source: string;
  readonly destination: string;
}

function toDescriptorPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function normalizeSharedArtifacts(shared: SharedArtifacts): SharedArtifacts {
  return {
    frontend: {
      root: toDescriptorPath(shared.frontend.root),
      sharedBundles: shared.frontend.sharedBundles.map(toDescriptorPath),
    },
    plugins: shared.plugins.map((plugin) => ({
      ...plugin,
      bundle: toDescriptorPath(plugin.bundle),
      staticBackends: plugin.staticBackends.map(toDescriptorPath),
    })),
  };
}

export interface ProductBuildHooks {
  readonly buildDaemon: (options: {
    readonly target: ProductTarget;
    readonly outputPath: string;
    readonly version: string;
  }) => void;
  readonly buildPluginBackends: (options: {
    readonly target: ProductTarget;
    readonly outputRoot: string;
  }) => readonly BuiltPluginBinary[];
}

export interface ProductBuildOptions {
  readonly repoRoot: string;
  readonly outputRoot: string;
  readonly descriptorPath: string;
  readonly target: ProductTarget;
  readonly version: string;
  readonly shared: SharedArtifacts;
  readonly hooks: ProductBuildHooks;
}

interface SharedDependencySnapshot {
  readonly bundles: readonly {readonly url: string}[];
}

interface PackedPluginArtifact {
  readonly schemaVersion: 1;
  readonly plugin: string;
  readonly entry: string;
  readonly staticBackends: readonly string[];
  readonly backend?: PackedBackendMetadata;
}

interface PackedBackendMetadata {
  readonly target: ProductTarget;
  readonly files: readonly {readonly path: string; readonly sha256: string}[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPackedBackendFile(value: unknown): value is {readonly path: string; readonly sha256: string} {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.path === 'string'
    && value.path.length > 0
    && !value.path.startsWith('/')
    && !value.path.split('/').includes('..')
    && typeof value.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(value.sha256);
}

function isPackedBackendMetadata(value: unknown): value is PackedBackendMetadata {
  return isRecord(value)
    && typeof value.target === 'string'
    && isProductTarget(value.target)
    && Array.isArray(value.files)
    && value.files.every(isPackedBackendFile);
}

function readPackedPluginArtifact(pluginDist: string, name: string): PackedPluginArtifact | null {
  const artifactPath = join(pluginDist, name, 'mndw-artifact.json');

  if (!existsSync(artifactPath)) {
    return null;
  }

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as Partial<PackedPluginArtifact>;

  if (
    artifact.schemaVersion !== 1
    || artifact.plugin !== name
    || typeof artifact.entry !== 'string'
    || !Array.isArray(artifact.staticBackends)
    || artifact.staticBackends.some((path) => typeof path !== 'string')
  ) {
    throw new Error(`invalid packed plugin artifact: ${artifactPath}`);
  }

  if (artifact.backend !== undefined) {
    if (!isPackedBackendMetadata(artifact.backend)) {
      throw new Error(`invalid packed backend metadata: ${artifactPath}`);
    }
  }

  return artifact as PackedPluginArtifact;
}

function createDefaultSharedArtifacts(repoRoot: string): SharedArtifacts {
  const snapshot = JSON.parse(
    readFileSync(join(repoRoot, 'contracts/protocol/shared-deps.json'), 'utf8'),
  ) as SharedDependencySnapshot;
  const pluginDist = join(repoRoot, 'plugins/builtin/dist');
  const plugins = existsSync(pluginDist)
    ? readdirSync(pluginDist)
      .filter((name) => statSync(join(pluginDist, name)).isDirectory())
      .filter((name) => existsSync(join(pluginDist, name, 'manifest.json')))
      .sort()
      .map((name) => {
        const artifact = readPackedPluginArtifact(pluginDist, name);

        if (artifact === null) {
          throw new Error(`packed plugin artifact metadata not found: ${join(pluginDist, name, 'mndw-artifact.json')}`);
        }

        return {
          name,
          bundle: join('plugins/builtin/dist', name),
          staticBackends: artifact.staticBackends,
        };
      })
    : [];

  return {
    frontend: {
      root: 'frontend/host/dist',
      sharedBundles: snapshot.bundles.map((bundle) => bundle.url.replace(/^\//, '')),
    },
    plugins,
  };
}

export function buildProductTargetWithDefaults(
  repoRoot: string,
  target: ProductTarget,
  outputRoot: string,
  descriptorPath: string,
  version: string,
): ArtifactDescriptor {
  return buildProductTarget({
    repoRoot,
    outputRoot,
    descriptorPath,
    target,
    version,
    shared: createDefaultSharedArtifacts(repoRoot),
    hooks: {
      buildDaemon: ({target: buildTarget, outputPath, version: buildVersion}) => {
        buildDaemonTarget({repoRoot, target: buildTarget, outputPath, version: buildVersion});
      },
      buildPluginBackends: ({target: buildTarget, outputRoot: targetRoot}) =>
        buildPluginBackends(repoRoot, buildTarget, targetRoot),
    },
  });
}

export function buildProductTarget(options: ProductBuildOptions): ArtifactDescriptor {
  const repoRoot = resolve(options.repoRoot);
  const outputRoot = resolve(options.outputRoot);
  const targetRoot = resolve(outputRoot, 'targets', options.target);
  const daemonPath = resolve(targetRoot, 'opt/sbin/mndwd');

  options.hooks.buildDaemon({
    target: options.target,
    outputPath: daemonPath,
    version: options.version,
  });

  const pluginBinaries = options.hooks.buildPluginBackends({
    target: options.target,
    outputRoot: targetRoot,
  }).map((binary) => ({
    plugin: binary.plugin,
    source: toDescriptorPath(relative(repoRoot, resolve(binary.source))),
    destination: toDescriptorPath(binary.destination),
  }));

  const shared = normalizeSharedArtifacts(options.shared);

  const descriptor: ArtifactDescriptor = {
    schemaVersion: 1,
    shared,
    targets: {[options.target]: {daemon: toDescriptorPath(relative(repoRoot, daemonPath)), pluginBinaries}},
  };

  let outputDescriptor = descriptor;

  if (existsSync(options.descriptorPath)) {
    const previous = readArtifactDescriptor(options.descriptorPath);

    outputDescriptor = {
      ...previous,
      shared: options.shared,
      targets: {...previous.targets, ...descriptor.targets},
    };
  }

  validateArtifactDescriptor(outputDescriptor);
  writeArtifactDescriptor(options.descriptorPath, outputDescriptor);

  return outputDescriptor;
}

function readVersion(repoRoot: string): string {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {version?: unknown};

  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Root package.json has no version');
  }

  return packageJson.version;
}

function parseTarget(args: readonly string[]): ProductTarget {
  const targetIndex = args.indexOf('--target');
  const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;

  if (target === undefined || !isProductTarget(target)) {
    throw new Error(`must specify --target with one of: ${PRODUCT_TARGETS.join(', ')}`);
  }

  return target;
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
  if (args[0] !== 'build') {
    throw new Error('usage: build --target <productTarget>');
  }

  const repoRoot = resolve(import.meta.dirname, '..');
  const target = parseTarget(args);
  const artifactRoot = join(repoRoot, 'artifacts');

  buildProductTargetWithDefaults(
    repoRoot,
    target,
    artifactRoot,
    join(artifactRoot, 'artifact-descriptor.json'),
    readVersion(repoRoot),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
