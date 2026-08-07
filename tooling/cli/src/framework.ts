import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

import {CliError} from './errors.js';

/** Supported plugin frameworks the packer can build. */
export type PluginFramework = 'vanilla' | 'svelte' | 'vue' | 'angular';

function hasExtension(dir: string, ext: string): boolean {
  let entries;

  try {
    entries = readdirSync(dir, {withFileTypes: true});
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (hasExtension(join(dir, entry.name), ext)) {
        return true;
      }

      continue;
    }

    if (entry.isFile() && entry.name.endsWith(ext)) {
      return true;
    }
  }

  return false;
}

/**
 * Detects a plugin's framework: a root `tsconfig.json` with `angularCompilerOptions` marks Angular;
 * otherwise a `.vue` file marks Vue, a `.svelte` file marks Svelte, and the absence of either marks
 * vanilla. More than one signal throws — a plugin must use a single framework.
 */
export function detectFramework(pluginDir: string): PluginFramework {
  const src = join(pluginDir, 'src');
  const hasAngular = hasAngularTsconfig(pluginDir);
  const hasVue = hasExtension(src, '.vue');
  const hasSvelte = hasExtension(src, '.svelte');

  if ([hasAngular, hasVue, hasSvelte].filter(Boolean).length > 1) {
    throw new CliError(
      'mixed framework sources: a plugin must use a single framework '
        + '(found more than one of an Angular tsconfig / a .vue file / a .svelte file)',
    );
  }

  if (hasAngular) {
    return 'angular';
  }

  if (hasVue) {
    return 'vue';
  }

  if (hasSvelte) {
    return 'svelte';
  }

  return 'vanilla';
}

/** True when the plugin's root `tsconfig.json` declares `angularCompilerOptions`. */
function hasAngularTsconfig(pluginDir: string): boolean {
  let raw: string;

  try {
    raw = readFileSync(join(pluginDir, 'tsconfig.json'), 'utf8');
  } catch {
    return false;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`Invalid tsconfig.json in ${pluginDir}: not valid JSON`);
  }

  return parsed !== null && typeof parsed === 'object' && 'angularCompilerOptions' in parsed;
}
