import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {verifyPackedBackend} from './example-plugins.js';
import {readPackedPluginArtifact} from './index.js';

const digest = 'a'.repeat(64);

function validArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    plugin: 'demo',
    entry: 'index.js',
    staticBackends: [],
    backend: {target: 'mipsel', files: [{path: 'backend/demo', sha256: digest}]},
    ...overrides,
  };
}

function assertErrorContains(action: () => unknown, ...fragments: string[]): void {
  let thrown = false;

  try {
    action();
  } catch (error) {
    thrown = true;
    assert(error instanceof Error);

    for (const fragment of fragments) {
      assert.match(error.message, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }

  assert.equal(thrown, true);
}

function writePackedArtifact(pluginDist: string, name: string, value: unknown): string {
  const pluginRoot = join(pluginDist, name);

  mkdirSync(pluginRoot, {recursive: true});

  const artifactPath = join(pluginRoot, 'mndw-artifact.json');

  writeFileSync(artifactPath, typeof value === 'string' ? value : JSON.stringify(value));

  return artifactPath;
}

function run(): void {
  const root = mkdtempSync(join(tmpdir(), 'mndw-packed-artifact-test-'));

  try {
    const pluginDist = join(root, 'plugins');
    const missing = readPackedPluginArtifact(pluginDist, 'demo');

    assert.equal(missing, null);

    const malformedPath = writePackedArtifact(pluginDist, 'demo', '{');

    assertErrorContains(
      () => readPackedPluginArtifact(pluginDist, 'demo'),
      malformedPath,
    );

    const invalidShapePath = writePackedArtifact(pluginDist, 'demo', validArtifact({schemaVersion: 2}));

    assertErrorContains(
      () => readPackedPluginArtifact(pluginDist, 'demo'),
      invalidShapePath,
      'schemaVersion',
    );

    const mismatchPath = writePackedArtifact(pluginDist, 'demo', validArtifact({plugin: 'other'}));

    assertErrorContains(
      () => readPackedPluginArtifact(pluginDist, 'demo'),
      mismatchPath,
      'expected plugin demo',
    );

    const packedRoot = join(root, 'packed');
    const packedArtifactPath = join(packedRoot, 'mndw-artifact.json');

    mkdirSync(join(packedRoot, 'backend'), {recursive: true});
    writeFileSync(packedArtifactPath, JSON.stringify(validArtifact()));

    assertErrorContains(
      () => verifyPackedBackend(packedRoot, 'aarch64', [{destination: 'backend/demo'}]),
      'target aarch64',
    );

    assertErrorContains(
      () => verifyPackedBackend(packedRoot, 'mipsel', [{destination: 'backend/demo'}]),
      'backend/demo',
    );

    mkdirSync(join(packedRoot, 'backend', 'demo'));

    assertErrorContains(
      () => verifyPackedBackend(packedRoot, 'mipsel', [{destination: 'backend/demo'}]),
      'backend/demo',
    );

    rmSync(join(packedRoot, 'backend', 'demo'), {recursive: true, force: true});
    writeFileSync(join(packedRoot, 'backend', 'demo'), 'actual bytes');

    assertErrorContains(
      () => verifyPackedBackend(packedRoot, 'mipsel', [{destination: 'backend/demo'}]),
      'does not match injected backend',
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

run();
