import {readdirSync} from 'node:fs';
import {join} from 'node:path';

import {CliError} from './errors.js';

/** Supported plugin frameworks the packer can build. */
export type PluginFramework = 'vanilla' | 'svelte' | 'vue';

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
 * Detects a plugin's framework by scanning its `src/` tree: any `.vue` file marks a Vue plugin, any
 * `.svelte` file marks a Svelte plugin, otherwise vanilla TypeScript. A tree containing BOTH throws —
 * a plugin must use a single framework, and silently picking one would let a stray SFC flip the build.
 */
export function detectFramework(pluginDir: string): PluginFramework {
  const src = join(pluginDir, 'src');
  const hasVue = hasExtension(src, '.vue');
  const hasSvelte = hasExtension(src, '.svelte');

  if (hasVue && hasSvelte) {
    throw new CliError(
      'mixed framework sources: found both .vue and .svelte under src/; a plugin must use a single framework',
    );
  }

  if (hasVue) {
    return 'vue';
  }

  if (hasSvelte) {
    return 'svelte';
  }

  return 'vanilla';
}
