import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

import {buildBackend} from '../tooling/cli/src/backend-build.js';
import type {BuiltPluginBinary} from './index.js';
import type {ProductTarget} from './targets.js';

export function buildPluginBackends(
  repoRoot: string,
  target: ProductTarget,
  outputRoot: string,
): BuiltPluginBinary[] {
  const binaries: BuiltPluginBinary[] = [];

  const builtinRoot = join(repoRoot, 'plugins/builtin');

  for (const plugin of readdirSync(builtinRoot).sort()) {
    const pluginDir = join(builtinRoot, plugin);

    if (!statSync(pluginDir).isDirectory() || !existsSync(join(pluginDir, 'package.json'))) {
      continue;
    }

    const packageJson = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as {
      readonly mndw?: {readonly backendBuildScript?: unknown};
    };

    if (typeof packageJson.mndw?.backendBuildScript !== 'string') {
      continue;
    }

    const pluginOutput = join(outputRoot, 'opt/share/www/mndw/plugins', plugin);
    const result = buildBackend({
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
