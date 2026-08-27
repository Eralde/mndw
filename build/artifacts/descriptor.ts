import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

import {type ProductTarget, isProductTarget} from '../targets.js';

export interface ArtifactDescriptor {
  readonly schemaVersion: 1;
  readonly shared: SharedArtifacts;
  readonly targets: Partial<Record<ProductTarget, TargetArtifacts>>;
}

export interface SharedArtifacts {
  readonly frontend: {readonly root: string; readonly sharedBundles: readonly string[]};
  readonly plugins: readonly {
    readonly name: string;
    readonly bundle: string;
    readonly staticBackends: readonly string[];
  }[];
}

export interface TargetArtifacts {
  readonly daemon: string;
  readonly pluginBinaries: readonly {
    readonly plugin: string;
    readonly source: string;
    readonly destination: string;
  }[];
}

function assertRelativePath(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.startsWith('\\')
    || value.includes('\\')
    || value.split('/').includes('..')
  ) {
    throw new Error(`${label} is outside declared artifact roots: ${String(value)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateArtifactDescriptor(value: unknown): asserts value is ArtifactDescriptor {
  if (typeof value !== 'object' || value === null) {
    throw new Error('artifact descriptor must be an object');
  }

  const descriptor = value as Record<string, unknown>;

  if (descriptor.schemaVersion !== 1) {
    throw new Error(`unsupported artifact descriptor schema version: ${String(descriptor.schemaVersion)}`);
  }

  if (!isRecord(descriptor.shared)) {
    throw new Error('artifact descriptor shared section is required');
  }

  const shared = descriptor.shared;

  if (!isRecord(shared.frontend)) {
    throw new Error('frontend root is required');
  }

  assertRelativePath(shared.frontend.root, 'frontend root');

  if (!Array.isArray(shared.frontend.sharedBundles)) {
    throw new Error('frontend shared bundles must be an array');
  }

  const sharedBundles = shared.frontend.sharedBundles as readonly unknown[];

  for (const [index, bundle] of sharedBundles.entries()) {
    assertRelativePath(bundle, `frontend shared bundle ${index}`);
  }

  if (!Array.isArray(shared.plugins)) {
    throw new Error('shared plugins must be an array');
  }

  const pluginNames = new Set<string>();
  const plugins = shared.plugins as readonly unknown[];

  for (const [index, plugin] of plugins.entries()) {
    if (!isRecord(plugin) || typeof plugin.name !== 'string' || plugin.name.length === 0) {
      throw new Error(`plugin ${index} name is required`);
    }

    if (pluginNames.has(plugin.name)) {
      throw new Error(`duplicate plugin name: ${plugin.name}`);
    }

    pluginNames.add(plugin.name);
    assertRelativePath(plugin.bundle, `plugin ${plugin.name} bundle`);

    if (!Array.isArray(plugin.staticBackends)) {
      throw new Error(`plugin ${plugin.name} static backends must be an array`);
    }

    const staticBackends = plugin.staticBackends as readonly unknown[];

    for (const [backendIndex, backend] of staticBackends.entries()) {
      assertRelativePath(backend, `plugin ${plugin.name} static backend ${backendIndex}`);
    }
  }

  if (!isRecord(descriptor.targets)) {
    throw new Error('artifact descriptor targets must be an object');
  }

  for (const [target, artifacts] of Object.entries(descriptor.targets)) {
    if (!isProductTarget(target)) {
      throw new Error(`unknown product target: ${target}`);
    }

    if (!isRecord(artifacts)) {
      throw new Error(`target artifacts are required: ${target}`);
    }

    assertRelativePath(artifacts.daemon, `${target} daemon`);

    if (!Array.isArray(artifacts.pluginBinaries)) {
      throw new Error(`${target} plugin binaries must be an array`);
    }

    const destinations = new Set<string>();
    const pluginBinaries = artifacts.pluginBinaries as readonly unknown[];

    for (const [index, binary] of pluginBinaries.entries()) {
      if (!isRecord(binary) || typeof binary.plugin !== 'string' || binary.plugin.length === 0) {
        throw new Error(`${target} plugin binary ${index} plugin is required`);
      }

      if (!pluginNames.has(binary.plugin)) {
        throw new Error(`${target} plugin binary references unknown plugin: ${binary.plugin}`);
      }

      assertRelativePath(binary.source, `${target} plugin binary ${binary.plugin} source`);
      assertRelativePath(binary.destination, `${target} plugin binary ${binary.plugin} destination`);

      if (destinations.has(binary.destination)) {
        throw new Error(`duplicate binary destination for ${target}: ${binary.destination}`);
      }

      destinations.add(binary.destination);
    }
  }
}

export function parseArtifactDescriptor(contents: string): ArtifactDescriptor {
  let value: unknown;

  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`malformed artifact descriptor: ${(error as Error).message}`);
  }

  validateArtifactDescriptor(value);

  return value;
}

export function readArtifactDescriptor(filePath: string): ArtifactDescriptor {
  return parseArtifactDescriptor(readFileSync(resolve(filePath), 'utf8'));
}

export function writeArtifactDescriptor(filePath: string, descriptor: ArtifactDescriptor): void {
  validateArtifactDescriptor(descriptor);

  const outputPath = resolve(filePath);

  mkdirSync(dirname(outputPath), {recursive: true});
  writeFileSync(outputPath, `${JSON.stringify(descriptor, null, 2)}\n`);
}
