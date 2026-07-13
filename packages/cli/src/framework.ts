import {readdirSync} from 'node:fs';
import {join} from 'node:path';

/** Supported plugin frameworks the packer can build. Vue/Angular arrive in Phase 7. */
export type PluginFramework = 'vanilla' | 'svelte';

/**
 * Detects a plugin's framework by scanning its `src/` tree: any `.svelte` file (entry or imported
 * component) marks a Svelte plugin; otherwise it is treated as vanilla TypeScript.
 */
export function detectFramework(pluginDir: string): PluginFramework {
  return hasSvelteFile(join(pluginDir, 'src')) ? 'svelte' : 'vanilla';
}

function hasSvelteFile(dir: string): boolean {
  let entries;

  try {
    entries = readdirSync(dir, {withFileTypes: true});
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (hasSvelteFile(join(dir, entry.name))) {
        return true;
      }

      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.svelte')) {
      return true;
    }
  }

  return false;
}
