import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

import {createProtocolDocuments, createSharedDependencySnapshot} from './generate-shared-deps.js';

const repoRoot = resolve(import.meta.dirname, '../..');

const run = (): void => {
  const snapshot = JSON.parse(readFileSync(join(repoRoot, 'contracts/protocol/shared-deps.json'), 'utf8'));

  assert.deepEqual(snapshot, createSharedDependencySnapshot(), 'shared-deps.json is stale');
  assert.equal('stdin' in snapshot.bundles[0], false, 'snapshot must exclude esbuild-only fields');

  for (const [relativePath, expected] of Object.entries(createProtocolDocuments())) {
    const actual = JSON.parse(readFileSync(join(repoRoot, 'contracts/protocol', relativePath), 'utf8'));

    assert.deepEqual(actual, expected, `${relativePath} is stale`);
  }
};

run();
