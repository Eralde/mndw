import {existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

const LOCKFILES: readonly {readonly file: string; readonly manager: PackageManager}[] = [
  {file: 'pnpm-lock.yaml', manager: 'pnpm'},
  {file: 'yarn.lock', manager: 'yarn'},
  {file: 'bun.lock', manager: 'bun'},
  {file: 'bun.lockb', manager: 'bun'},
  {file: 'package-lock.json', manager: 'npm'},
];

const PACKAGE_MANAGERS: readonly PackageManager[] = ['pnpm', 'npm', 'yarn', 'bun'];

/** Detects the invoking package manager, then falls back to the nearest lockfile and finally npm. */
export function detectPackageManager(options: {env?: NodeJS.ProcessEnv; cwd?: string} = {}): PackageManager {
  const env = options.env ?? process.env;
  const userAgent = env.npm_config_user_agent;
  const firstToken = userAgent?.trim().split(/\s+/)[0];
  const agentName = firstToken?.split('/')[0];

  if (PACKAGE_MANAGERS.includes(agentName as PackageManager)) {
    return agentName as PackageManager;
  }

  let directory = resolve(options.cwd ?? process.cwd());

  while (true) {
    for (const lockfile of LOCKFILES) {
      if (existsSync(resolve(directory, lockfile.file))) {
        return lockfile.manager;
      }
    }

    const parent = dirname(directory);

    if (parent === directory) {
      break;
    }

    directory = parent;
  }

  return 'npm';
}
