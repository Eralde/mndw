import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

import {type Zippable, zipSync} from 'fflate';
import {type PluginManifest} from '@mndw/sdk-internal';

import {type PackOptions, type PackResult, packPlugin} from './pack.js';
import {resolvePluginDir} from './paths.js';

export interface ZipOptions extends PackOptions {
  /** Archive destination. Defaults to `<plugin-dir>/<plugin-name>.zip`. */
  readonly output?: string;
}

export interface ZipResult {
  readonly outputPath: string;
  readonly pack: PackResult;
}

/** Returns backend command paths whose archive entries must be executable. */
export function backendCommandPaths(manifest: PluginManifest): ReadonlySet<string> {
  const backend = manifest.backend;

  if (backend === undefined) {
    return new Set();
  }

  if (backend.kind === 'exec') {
    return new Set(backend.routes.map((route) => route.command));
  }

  return new Set([backend.command]);
}

function collectFiles(dir: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};

  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      // Skip hidden files and dirs; this also covers `.DS_Store`.
      if (entry.name.startsWith('.')) {
        continue;
      }

      const absolute = join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        files[relative] = readFileSync(absolute);
      }
    }
  };

  walk(dir, '');

  return files;
}

/** Builds a ZIP of a directory's contents (root-relative paths), skipping hidden files. */
export function zipDirectory(dir: string, executables: ReadonlySet<string> = new Set()): Uint8Array {
  const files: Zippable = {};

  for (const [path, contents] of Object.entries(collectFiles(dir))) {
    const perm = executables.has(path) ? 0o755 : 0o644;

    files[path] = [contents, {os: 3, attrs: (0o100000 + perm) * 0x10000}];
  }

  return zipSync(files, {level: 9});
}

/**
 * Packs a plugin, then writes an uploadable ZIP whose root is the packed output — the daemon finds
 * `manifest.json` at the archive root, not inside a `dist/` wrapper. Hidden files (including
 * `.DS_Store`) are excluded.
 */
export async function zipPlugin(pluginDir: string, options: ZipOptions = {}): Promise<ZipResult> {
  const {output, ...packOptions} = options;
  const pack = await packPlugin(pluginDir, packOptions);
  const archive = zipDirectory(pack.outDir, backendCommandPaths(pack.manifest));

  const outputPath = output === undefined
    ? join(resolvePluginDir(pluginDir), `${pack.manifest.name}.zip`)
    : resolve(process.cwd(), output);

  mkdirSync(dirname(outputPath), {recursive: true});
  writeFileSync(outputPath, archive);

  return {outputPath, pack};
}
