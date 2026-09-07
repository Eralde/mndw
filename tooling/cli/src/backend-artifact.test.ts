import {isAbsolute} from 'node:path';

import {describe, expect, it} from 'vitest';

import {parseBackendArtifact} from './backend-artifact.js';

const validArtifact = {
  plugin: 'demo',
  target: 'mipsel',
  binaries: [{source: 'demo', destination: 'backend/demo'}],
};

describe('parseBackendArtifact', () => {
  it('parses backend metadata into its typed shape', () => {
    expect(parseBackendArtifact(validArtifact)).toEqual(validArtifact);
  });

  it('accepts empty binary arrays and ignores unknown fields', () => {
    expect(parseBackendArtifact({plugin: 'demo', target: 'mipsel', binaries: [], extra: 'accepted'})).toEqual({
      plugin: 'demo',
      target: 'mipsel',
      binaries: [],
    });
  });

  it('retains the current platform-sensitive absolute path behavior', () => {
    const source = 'C:/demo';
    const artifact = {...validArtifact, binaries: [{source, destination: 'backend/demo'}]};

    if (isAbsolute(source)) {
      expect(() => parseBackendArtifact(artifact)).toThrow('source');
    } else {
      expect(parseBackendArtifact(artifact)).toEqual(artifact);
    }
  });

  it.each([
    ['null root', null, 'artifact'],
    ['array root', [], 'artifact'],
    ['string root', 'artifact', 'artifact'],
    ['missing plugin', {...validArtifact, plugin: undefined}, 'plugin'],
    ['wrong plugin', {...validArtifact, plugin: 42}, 'plugin'],
    ['unknown target', {...validArtifact, target: 'unsupported'}, 'target'],
    ['missing target', {...validArtifact, target: undefined}, 'target'],
    ['wrong binaries', {...validArtifact, binaries: {}}, 'binaries'],
    ['missing binaries', {...validArtifact, binaries: undefined}, 'binaries'],
    ['malformed binary', {...validArtifact, binaries: [null]}, 'binaries[0]'],
    ['empty source', {...validArtifact, binaries: [{source: '', destination: 'backend/demo'}]}, 'source'],
    ['absolute source', {...validArtifact, binaries: [{source: '/demo', destination: 'backend/demo'}]}, 'source'],
    ['traversal source', {...validArtifact, binaries: [{source: '../demo', destination: 'backend/demo'}]}, 'source'],
    [
      'backslash source',
      {...validArtifact, binaries: [{source: 'backend\\demo', destination: 'backend/demo'}]},
      'source',
    ],
    ['empty destination', {...validArtifact, binaries: [{source: 'demo', destination: ''}]}, 'destination'],
    [
      'absolute destination',
      {...validArtifact, binaries: [{source: 'demo', destination: '/backend/demo'}]},
      'destination',
    ],
    [
      'traversal destination',
      {...validArtifact, binaries: [{source: 'demo', destination: 'backend/../demo'}]},
      'destination',
    ],
    [
      'backslash destination',
      {...validArtifact, binaries: [{source: 'demo', destination: 'backend\\demo'}]},
      'destination',
    ],
    [
      'duplicate destination',
      {...validArtifact, binaries: [validArtifact.binaries[0], validArtifact.binaries[0]]},
      'destination',
    ],
  ])('rejects %s with a field-specific error', (_name, value, field) => {
    expect(() => parseBackendArtifact(value)).toThrow(String(field));
  });
});
