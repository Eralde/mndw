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

  it('has a non-trivial manifest corpus', () => {
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
    manifestVersion: 1 as const,
    name: 'test-plugin',
    version: '3.0.0',
    type: 'widget' as const,
    label: 'Backend Plugin',
    entry: 'index.js',
    size: {w: 4, h: 3},
  };

  it('accepts manifest version 1 and rejects another version', () => {
    expect(() => validateManifest({...base, manifestVersion: 1})).not.toThrow();
    expect(() => validateManifest({...base, manifestVersion: 999})).toThrow(ManifestValidationError);
  });

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

    expect(result.manifestVersion).toBe(1);
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
    ['absolute entry', '/dist/index.js'],
    ['backslash entry', 'dist\\index.js'],
    ['parent entry', 'dist/../index.js'],
    ['dot-segment entry', 'dist/./index.js'],
  ])('rejects unsafe %s paths', (_label, entry) => {
    expect(() => validateManifest({...base, entry})).toThrow(ManifestValidationError);
  });

  it.each([
    ['absolute command', '/backend/run.sh'],
    ['backslash command', 'backend\\run.sh'],
    ['parent command', 'backend/../run.sh'],
    ['dot-segment command', 'backend/./run.sh'],
  ])('rejects unsafe %s paths', (_label, command) => {
    expect(() =>
      validateManifest({
        ...base,
        backend: {
          kind: 'exec',
          routes: [{id: 'run', transport: 'http', method: 'GET', path: 'run', command}],
        },
      })
    ).toThrow(ManifestValidationError);
  });

  it.each([
    ['encoded separator', 'run%2Fnow'],
    ['double-encoded separator', 'run%252Fnow'],
    ['dot segment', 'run/./now'],
    ['parent segment', 'run/../now'],
    ['query', 'run?next'],
    ['fragment', 'run#next'],
    ['reserved namespace', '_mndw/status'],
  ])('rejects unsafe backend route %s', (_label, path) => {
    expect(() =>
      validateManifest({
        ...base,
        backend: {
          kind: 'exec',
          routes: [{id: 'run', transport: 'http', method: 'GET', path, command: 'backend/run.sh'}],
        },
      })
    ).toThrow(ManifestValidationError);
  });

  it('accepts safe nested relative paths', () => {
    expect(() =>
      validateManifest({
        ...base,
        entry: 'dist/index.js',
        backend: {
          kind: 'exec',
          routes: [{id: 'run', transport: 'http', method: 'GET', path: 'api/run', command: 'backend/run.sh'}],
        },
      })
    ).not.toThrow();
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

  it('aggregates invalid fields with their paths', () => {
    try {
      validateManifest({
        ...base,
        name: 'Bad Name',
        entry: '/dist/index.js',
        size: {w: 13, h: 0},
        backend: {
          kind: 'exec',
          routes: [{id: '', transport: 'http', method: 'POST', path: 'run?next', command: '/backend/run.sh'}],
        },
      });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);

      const validationError = error as ManifestValidationError;
      const paths = validationError.issues.map((issue) => issue.path);

      expect(paths).toEqual(expect.arrayContaining([
        'name',
        'entry',
        'size.w',
        'size.h',
        'backend.routes.0.id',
        'backend.routes.0.path',
        'backend.routes.0.command',
      ]));
      expect(validationError.message).toContain('backend.routes.0.path');
    }
  });

  it('uses the existing type discriminator to select widget and page branches', () => {
    const page = validateManifest({
      manifestVersion: 1,
      name: 'page-plugin',
      version: '3.0.0',
      type: 'page',
      label: 'Page Plugin',
      entry: 'index.js',
      route: '/page-plugin',
    });

    expect(page.type).toBe('page');
    expect('route' in page).toBe(true);
  });
});
