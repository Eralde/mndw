import {existsSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

import {cliPackageRoot} from './cli-package-root.js';

/** Returns every existing node_modules directory from this package root to filesystem root. */
export function cliNodePaths(root: string = cliPackageRoot()): string[] {
  const paths: string[] = [];
  let directory = resolve(root);

  for (;;) {
    const modules = join(directory, 'node_modules');

    if (existsSync(modules) && statSync(modules).isDirectory()) {
      paths.push(modules);
    }

    const parent = dirname(directory);

    if (parent === directory) {
      return paths;
    }

    directory = parent;
  }
}

/** Plugin-local dependencies take priority; CLI dependencies fill gaps, with paths included once. */
export function packNodePaths(pluginDir: string, cliRoot: string = cliPackageRoot()): string[] {
  return [...new Set([...cliNodePaths(pluginDir), ...cliNodePaths(cliRoot)])];
}
