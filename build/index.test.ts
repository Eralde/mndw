import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {buildProductTarget} from './index.js';

const run = (): void => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'mndw-descriptor-test-'));
  const outputRoot = join(repoRoot, 'artifacts');
  const descriptorPath = join(outputRoot, 'artifact-descriptor.json');
  const calls: string[] = [];

  const descriptor = buildProductTarget({
    repoRoot,
    outputRoot,
    descriptorPath,
    target: 'mipsel',
    version: '0.0.0',
    shared: {
      frontend: {root: 'frontend/host/dist', sharedBundles: ['shared/rxjs@7.8.2.js']},
      plugins: [{name: 'demo', bundle: join('plugins', 'builtin', 'dist', 'demo'), staticBackends: []}],
    },
    hooks: {
      buildDaemon: ({target, outputPath}) => {
        calls.push(`daemon:${target}:${outputPath}`);
      },
      buildPluginBackends: ({target, outputRoot: pluginRoot}) => {
        calls.push(`plugins:${target}:${pluginRoot}`);

        return [{
          plugin: 'demo',
          source: join(pluginRoot, 'opt/share/www/mndw/plugins/demo/backend/mndwd'),
          destination: 'backend/mndwd',
        }];
      },
    },
  });

  assert.deepEqual(calls.map((call) => call.split(':')[0]), ['daemon', 'plugins']);
  assert.equal(descriptor.targets.mipsel?.daemon, 'artifacts/targets/mipsel/opt/sbin/mndwd');
  assert.equal(descriptor.targets.mipsel?.pluginBinaries[0]?.plugin, 'demo');
  assert.equal(descriptor.shared.plugins[0]?.bundle, 'plugins/builtin/dist/demo');
  assert.equal(
    descriptor.targets.mipsel?.pluginBinaries[0]?.source,
    'artifacts/targets/mipsel/opt/share/www/mndw/plugins/demo/backend/mndwd',
  );
  assert.deepEqual(JSON.parse(readFileSync(descriptorPath, 'utf8')), descriptor);
  rmSync(repoRoot, {recursive: true, force: true});
};

run();
