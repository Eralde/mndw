import {createRequire} from 'node:module';
import {dirname, resolve as resolvePath} from 'node:path';

import {CliError} from './errors.js';
import {MNDWD_PLATFORMS, mndwdPlatformFor} from './mndwd-platforms.js';

const nodeRequire = createRequire(import.meta.url);

export interface ResolvePackagedDaemonDeps {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly resolve?: (specifier: string) => string;
}

export function resolvePackagedDaemon(deps: ResolvePackagedDaemonDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const target = mndwdPlatformFor(platform, arch);

  if (target === undefined) {
    const supported = MNDWD_PLATFORMS.map((entry) => `${entry.os}/${entry.cpu}`).join(', ');

    throw new CliError(
      `mndw dev: no prebuilt mndwd for ${platform}/${arch}; supported: ${supported}. Pass --daemon <path>.`,
    );
  }

  let packageJsonPath: string;

  try {
    packageJsonPath = (deps.resolve ?? ((specifier) => nodeRequire.resolve(specifier)))(
      `${target.packageName}/package.json`,
    );
  } catch {
    throw new CliError(
      `mndw dev: ${target.packageName} is not installed. Reinstall @mndw/cli without --no-optional `
        + '(with npm, delete package-lock.json and node_modules first: npm can drop optional platform packages '
        + 'from a lockfile made on another OS), or pass --daemon <path>.',
    );
  }

  return resolvePath(dirname(packageJsonPath), 'bin', target.binary);
}
