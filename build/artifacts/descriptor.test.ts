import assert from 'node:assert/strict';
import {type ArtifactDescriptor, validateArtifactDescriptor} from './descriptor.js';

const validDescriptor = (): ArtifactDescriptor => ({
  schemaVersion: 1,
  shared: {
    frontend: {root: 'frontend/host/dist', sharedBundles: ['shared/rxjs@7.8.2.js']},
    plugins: [{name: 'demo', bundle: 'plugins/demo', staticBackends: ['backend/status']}],
  },
  targets: {
    mipsel: {
      daemon: 'opt/sbin/mndwd',
      pluginBinaries: [{plugin: 'demo', source: 'build/demo/mipsel/mndwd', destination: 'backend/mndwd'}],
    },
  },
});

const run = (): void => {
  assert.doesNotThrow(() => validateArtifactDescriptor(validDescriptor()));
  assert.throws(
    () => validateArtifactDescriptor({...validDescriptor(), schemaVersion: 2} as unknown as ArtifactDescriptor),
  );
  assert.throws(
    () =>
      validateArtifactDescriptor({
        ...validDescriptor(),
        targets: {...validDescriptor().targets, 'x86-64': validDescriptor().targets.mipsel},
      } as unknown as ArtifactDescriptor),
    /unknown product target/,
  );
  assert.throws(
    () =>
      validateArtifactDescriptor({
        ...validDescriptor(),
        shared: {...validDescriptor().shared, frontend: {root: '', sharedBundles: []}},
      }),
    /frontend root/,
  );
  assert.throws(
    () =>
      validateArtifactDescriptor({
        ...validDescriptor(),
        shared: {...validDescriptor().shared, plugins: [
          ...validDescriptor().shared.plugins,
          {name: 'demo', bundle: 'plugins/other', staticBackends: []},
        ]},
      }),
    /duplicate plugin/,
  );
  assert.throws(
    () =>
      validateArtifactDescriptor({
        ...validDescriptor(),
        targets: {mipsel: {
          daemon: 'opt/sbin/mndwd',
          pluginBinaries: [
            {plugin: 'demo', source: 'a', destination: 'backend/mndwd'},
            {plugin: 'demo', source: 'b', destination: 'backend/mndwd'},
          ],
        }},
      }),
    /duplicate binary destination/,
  );
  assert.throws(
    () =>
      validateArtifactDescriptor({
        ...validDescriptor(),
        targets: {mipsel: {daemon: '../mndwd', pluginBinaries: []}},
      }),
    /outside/,
  );
};

run();
