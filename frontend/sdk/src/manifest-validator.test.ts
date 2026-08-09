import {readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {ManifestValidationError, validateManifest} from './manifest-validator.js';

const fixturesRoot = resolve(import.meta.dirname, '..', 'fixtures', 'manifests');

const loadFixtures = (kind: 'valid' | 'invalid'): Array<{name: string; data: unknown}> => {
  const directory = resolve(fixturesRoot, kind);

  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      return {name: file, data: JSON.parse(readFileSync(resolve(directory, file), 'utf8'))};
    });
};

describe('manifest fixture corpus', () => {
  const validFixtures = loadFixtures('valid');
  const invalidFixtures = loadFixtures('invalid');

  it('has a non-trivial v3 corpus', () => {
    expect(validFixtures.length).toBeGreaterThanOrEqual(8);
    expect(invalidFixtures.length).toBeGreaterThanOrEqual(20);
  });

  it.each(validFixtures)('accepts valid/$name', ({data}) => {
    expect(() => validateManifest(data)).not.toThrow();
  });

  it.each(invalidFixtures)('rejects invalid/$name', ({data}) => {
    expect(() => validateManifest(data)).toThrow(ManifestValidationError);
  });
});

describe('validateManifest behavior', () => {
  const base = {
    manifestVersion: 3 as const,
    name: 'v3-plugin',
    version: '3.0.0',
    type: 'widget' as const,
    label: 'V3 Plugin',
    entry: 'index.js',
    size: {w: 4, h: 3},
  };

  it('accepts persistent RCI read and write permissions and strips editor schema metadata', () => {
    const result = validateManifest({
      ...base,
      $schema: '../manifest.schema.json',
      permissions: ['persistent-rci-session:read', 'persistent-rci-session:write'],
    });

    expect(result.permissions).toEqual(['persistent-rci-session:read', 'persistent-rci-session:write']);
    expect('$schema' in result).toBe(false);
  });

  it.each([
    ['persistent-rci-session:read', 'duplicate read'],
    ['persistent-rci-session:write', 'duplicate write'],
  ])('rejects %s permission duplicates', (permission) => {
    expect(() => validateManifest({...base, permissions: [permission, permission]})).toThrow(ManifestValidationError);
  });

  it('rejects the retired persistent RCI permission', () => {
    expect(() => validateManifest({...base, permissions: ['persistent-rci-session']})).toThrow(ManifestValidationError);
  });

  it('normalizes route method and defaults access to session', () => {
    const result = validateManifest({
      ...base,
      backend: {
        kind: 'exec',
        routes: [{id: 'echo', transport: 'http', method: 'post', path: 'echo', command: 'backend/echo.sh'}],
      },
    });

    expect(result.manifestVersion).toBe(3);
    expect(result.backend?.kind).toBe('exec');
    expect(result.backend?.routes[0]).toMatchObject({method: 'POST', access: 'session'});
  });

  it('accepts a service command, literal args, HTTP, and WebSocket routes', () => {
    const result = validateManifest({
      ...base,
      backend: {
        kind: 'service',
        protocolVersion: 1,
        command: 'backend/server',
        args: ['--foreground'],
        routes: [
          {id: 'status', transport: 'http', method: 'GET', path: 'status'},
          {id: 'terminal', transport: 'websocket', path: 'terminal', protocols: ['tty']},
        ],
      },
    });

    expect(result.backend?.kind).toBe('service');
    expect(result.backend?.routes).toHaveLength(2);
  });

  it.each([
    {name: 'exec websocket',
      backend: {kind: 'exec', routes: [{id: 'ws', transport: 'websocket', path: 'ws', command: 'backend/ws'}]}},
    {name: 'public post',
      backend: {kind: 'exec',
        routes: [{id: 'post', transport: 'http', method: 'POST', path: 'post', access: 'public',
          command: 'backend/post'}]}},
    {name: 'reserved route',
      backend: {kind: 'exec',
        routes: [{id: 'ready', transport: 'http', method: 'GET', path: '_mndw/ready', command: 'backend/get'}]}},
    {name: 'mixed backend fields',
      backend: {kind: 'exec', legacy: [],
        routes: [{id: 'echo', transport: 'http', method: 'GET', path: 'echo', command: 'backend/echo.sh'}]}},
  ])('rejects $name', ({backend}) => {
    expect(() => validateManifest({...base, backend})).toThrow(ManifestValidationError);
  });

  it('surfaces plugin name in validation errors', () => {
    expect(() => validateManifest({...base, name: 'Bad Name'})).toThrow(/Bad Name/);
    expect(() => validateManifest({type: 'widget'})).toThrow(/unknown/);
  });
});
