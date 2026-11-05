import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

/** Finds this package root from either its source directory or installed dist directory. */
export function cliPackageRoot(startDir: string = import.meta.dirname): string {
  let directory = resolve(startDir);

  for (;;) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as {name?: string};

      if (parsed.name === '@mndw/cli') {
        return directory;
      }
    } catch {
      // Continue walking when this directory has no readable package manifest.
    }

    const parent = dirname(directory);

    if (parent === directory) {
      throw new Error(`Could not locate @mndw/cli package root above ${startDir}`);
    }

    directory = parent;
  }
}
