import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';

import {type PluginManifestOutput} from '@mndw/sdk';
import {pluginDependencies, sharedDependencyVersions} from '@mndw/sdk/shared-dependencies';

import {CliError} from './errors.js';
import {type PluginFramework} from './framework.js';

/** Schema version of `mndw.lock.json`. Bumped only on a breaking lock-format change. */
export const LOCK_VERSION = 1;

export interface LockFile {
  readonly lockVersion: typeof LOCK_VERSION;
  readonly plugin: {readonly name: string; readonly version: string};
  readonly framework: PluginFramework;
  /** Exact resolved `@mndw/sdk` package version the plugin was built against. */
  readonly sdkVersion: string;
  /** `specifier → version` the plugin externalized, sorted by specifier. */
  readonly sharedDependencies: Record<string, string>;
}

/**
 * Resolves the exact version of the `@mndw/sdk` package the CLI runs against — never a plugin's
 * declared dependency range. Resolves the package entry from the CLI module context, walks up to the
 * containing package root, and reads its `package.json` `version`.
 */
export function resolveSdkVersion(): string {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve('@mndw/sdk'));

  for (;;) {
    const packageJsonPath = join(dir, 'package.json');

    if (existsSync(packageJsonPath)) {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {name?: string; version?: string};

      if (parsed.name === '@mndw/sdk') {
        if (typeof parsed.version !== 'string') {
          throw new CliError('@mndw/sdk package.json has no version');
        }

        return parsed.version;
      }
    }

    const parent = dirname(dir);

    if (parent === dir) {
      throw new CliError('Could not locate the @mndw/sdk package root');
    }

    dir = parent;
  }
}

/** Base package name of a shared specifier (`rxjs/operators` → `rxjs`, `@a/b/c` → `@a/b`). */
export function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');

  return specifier.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
}

/**
 * Names of host-shared packages that leaked into the bundle as compiled input. Derived from the
 * esbuild metafile inputs rather than string-scanning minified output, so it is exact.
 */
export function findBundledSharedDependencies(
  metafile: {readonly inputs: Readonly<Record<string, unknown>>},
  specifiers: readonly string[],
): string[] {
  const packages = [...new Set(specifiers.map(packageNameOf))];
  const found = new Set<string>();

  for (const input of Object.keys(metafile.inputs)) {
    for (const packageName of packages) {
      if (input.startsWith(`node_modules/${packageName}/`) || input.includes(`/node_modules/${packageName}/`)) {
        found.add(packageName);
      }
    }
  }

  return [...found].sort();
}

/** Builds the lock record for a packed plugin. */
export function buildLock(manifest: PluginManifestOutput, framework: PluginFramework): LockFile {
  const versions = sharedDependencyVersions();
  const specifiers = [...pluginDependencies(framework)].sort();
  const sharedDependencies: Record<string, string> = {};

  for (const specifier of specifiers) {
    sharedDependencies[specifier] = versions[specifier];
  }

  return {
    lockVersion: LOCK_VERSION,
    plugin: {name: manifest.name, version: manifest.version},
    framework,
    sdkVersion: resolveSdkVersion(),
    sharedDependencies,
  };
}

/** Serializes a lock to deterministic, indented, newline-terminated JSON. */
export function serializeLock(lock: LockFile): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** Parses a lock file, raising a deterministic reader error on malformed input or unknown version. */
export function parseLock(contents: string): LockFile {
  let data: unknown;

  try {
    data = JSON.parse(contents);
  } catch (error) {
    throw new CliError(`Malformed mndw.lock.json: ${(error as Error).message}`);
  }

  if (typeof data !== 'object' || data === null) {
    throw new CliError('Malformed mndw.lock.json: expected a JSON object');
  }

  const lockVersion = (data as {lockVersion?: unknown}).lockVersion;

  if (lockVersion !== LOCK_VERSION) {
    throw new CliError(`Unsupported mndw.lock.json version: ${String(lockVersion)} (expected ${LOCK_VERSION})`);
  }

  return data as LockFile;
}
