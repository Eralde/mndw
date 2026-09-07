import {describe, expect, it} from 'vitest';

import {parsePackedPluginArtifact} from './packed-plugin-artifact.js';

const digest = 'a'.repeat(64);

const validArtifact = {
  schemaVersion: 1,
  plugin: 'demo',
  entry: 'index.js',
  staticBackends: [],
  backend: {target: 'mipsel', files: [{path: 'backend/demo', sha256: digest}]},
};

const invalidPackedArtifacts: readonly [string, unknown, string][] = [
  ['null root', null, 'artifact'],
  ['array root', [], 'artifact'],
  ['string root', 'artifact', 'artifact'],
  ['wrong schema version', {...validArtifact, schemaVersion: 2}, 'schemaVersion'],
  ['missing plugin', {...validArtifact, plugin: undefined}, 'plugin'],
  ['wrong plugin', {...validArtifact, plugin: 42}, 'plugin'],
  ['missing entry', {...validArtifact, entry: undefined}, 'entry'],
  ['wrong entry', {...validArtifact, entry: 42}, 'entry'],
  ['missing static backends', {...validArtifact, staticBackends: undefined}, 'staticBackends'],
  ['wrong static backends', {...validArtifact, staticBackends: {}}, 'staticBackends'],
  ['wrong static backend element', {...validArtifact, staticBackends: ['ok', 42]}, 'staticBackends[1]'],
  ['unknown backend target', {...validArtifact, backend: {target: 'unsupported', files: []}}, 'backend.target'],
  ['missing backend files', {...validArtifact, backend: {target: 'mipsel'}}, 'backend.files'],
  ['wrong backend files', {...validArtifact, backend: {target: 'mipsel', files: {}}}, 'backend.files'],
  ['malformed backend file', {...validArtifact, backend: {target: 'mipsel', files: [null]}}, 'backend.files[0]'],
  [
    'empty backend file path',
    {...validArtifact, backend: {target: 'mipsel', files: [{path: '', sha256: digest}]}},
    'path',
  ],
  ['absolute backend file path', {...validArtifact,
    backend: {target: 'mipsel', files: [{path: '/demo', sha256: digest}]}}, 'path'],
  ['traversal backend file path', {...validArtifact,
    backend: {target: 'mipsel', files: [{path: 'backend/../demo', sha256: digest}]}}, 'path'],
  ['uppercase digest', {...validArtifact,
    backend: {target: 'mipsel', files: [{path: 'backend/demo', sha256: digest.toUpperCase()}]}}, 'sha256'],
  [
    'short digest',
    {...validArtifact, backend: {target: 'mipsel', files: [{path: 'backend/demo', sha256: 'a'}]}},
    'sha256',
  ],
  ['non-hex digest', {...validArtifact,
    backend: {target: 'mipsel', files: [{path: 'backend/demo', sha256: `${'a'.repeat(63)}g`}]}}, 'sha256'],
];

describe('parsePackedPluginArtifact', () => {
  it('parses a packed plugin artifact into its typed shape', () => {
    expect(parsePackedPluginArtifact(validArtifact)).toEqual(validArtifact);
  });

  it('accepts artifacts without compiled backend metadata and with empty arrays', () => {
    expect(parsePackedPluginArtifact({
      schemaVersion: 1,
      plugin: 'demo',
      entry: 'index.js',
      staticBackends: [],
    })).toEqual({
      schemaVersion: 1,
      plugin: 'demo',
      entry: 'index.js',
      staticBackends: [],
    });

    expect(parsePackedPluginArtifact({...validArtifact, backend: {target: 'mipsel', files: []}}))
      .toEqual({...validArtifact, backend: {target: 'mipsel', files: []}});
  });

  it('ignores unknown fields while retaining known fields', () => {
    expect(parsePackedPluginArtifact({...validArtifact, extra: 'accepted'})).toEqual(validArtifact);
  });

  it('preserves the current string-only path policy for entry and static backends', () => {
    expect(parsePackedPluginArtifact({...validArtifact, entry: '', staticBackends: ['', 'backend\\demo']}))
      .toEqual({...validArtifact, entry: '', staticBackends: ['', 'backend\\demo']});
  });

  it('accepts backslashes in packed backend file paths for compatibility', () => {
    expect(parsePackedPluginArtifact({
      ...validArtifact,
      backend: {target: 'mipsel', files: [{path: 'backend\\demo', sha256: digest}]},
    })).toEqual({
      ...validArtifact,
      backend: {target: 'mipsel', files: [{path: 'backend\\demo', sha256: digest}]},
    });
  });

  it.each(invalidPackedArtifacts)('rejects %s with a field-specific error', (_name, value, field) => {
    expect(() => parsePackedPluginArtifact(value)).toThrow(field);
  });
});
