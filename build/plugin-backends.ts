import {chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {buildBackend} from '../tooling/cli/src/backend-build.js';
import type {BuiltPluginBinary} from './index.js';
import type {ProductTarget} from './targets.js';
import {BUILTIN_BACKEND_NAMES} from './builtin-backends.js';

export function buildPluginBackends(
  repoRoot: string,
  target: ProductTarget,
  outputRoot: string,
  buildBackendFn: typeof buildBackend = buildBackend,
): BuiltPluginBinary[] {
  const binaries: BuiltPluginBinary[] = [];

  const builtinRoot = join(repoRoot, 'plugins/builtin');

  for (const plugin of readdirSync(builtinRoot).sort()) {
    const pluginDir = join(builtinRoot, plugin);

    if (!statSync(pluginDir).isDirectory() || !existsSync(join(pluginDir, 'package.json'))) {
      continue;
    }

    const packageJson = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as {
      readonly mndw?: {
        readonly backendBuildScript?: unknown;
        readonly backend?: {readonly binaryName?: unknown};
      };
    };

    if (typeof packageJson.mndw?.backendBuildScript !== 'string') {
      continue;
    }

    const pluginOutput = join(outputRoot, 'opt/share/www/mndw/plugins', plugin);
    const binaryName = packageJson.mndw?.backend?.binaryName;

    if (typeof binaryName === 'string' && BUILTIN_BACKEND_NAMES.some((name) => name === binaryName)) {
      const source = join(pluginOutput, binaryName);

      mkdirSync(pluginOutput, {recursive: true});
      writeFileSync(source, `#!/bin/sh\nexec /opt/sbin/mndwd backend ${binaryName} "$@"\n`);
      chmodSync(source, 0o755);
      binaries.push({
        plugin,
        source,
        destination: ['opt', 'share', 'www', 'mndw', 'plugins', plugin, 'backend', binaryName].join('/'),
      });

      continue;
    }

    const result = buildBackendFn({
      pluginDir,
      plugin,
      target,
      outDir: pluginOutput,
    });

    if (result === null) {
      continue;
    }

    for (const binary of result.binaries) {
      binaries.push({
        plugin,
        source: join(pluginOutput, binary.source),
        destination: join('opt/share/www/mndw/plugins', plugin, binary.destination).split('/')
          .join('/'),
      });
    }
  }

  return binaries;
}
