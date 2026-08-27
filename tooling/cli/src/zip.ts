import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

import {zipSync} from 'fflate';

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

/**
 * Packs a plugin, then writes an uploadable ZIP whose root is the packed output — the daemon finds
 * `manifest.json` at the archive root, not inside a `dist/` wrapper. Hidden files (including
 * `.DS_Store`) are excluded.
 */
export async function zipPlugin(pluginDir: string, options: ZipOptions = {}): Promise<ZipResult> {
  const {output, ...packOptions} = options;
  const pack = await packPlugin(pluginDir, packOptions);
  const archive = zipDirectory(pack.outDir);

  const outputPath = output === undefined
    ? join(resolvePluginDir(pluginDir), `${pack.manifest.name}.zip`)
    : resolve(process.cwd(), output);

  mkdirSync(dirname(outputPath), {recursive: true});
  writeFileSync(outputPath, archive);

  return {outputPath, pack};
}

/** Builds a ZIP of a directory's contents (root-relative paths), skipping hidden files. */
export function zipDirectory(dir: string): Uint8Array {
  return zipSync(collectFiles(dir), {level: 9});
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
