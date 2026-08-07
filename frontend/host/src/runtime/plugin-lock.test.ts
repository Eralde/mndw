import {afterEach, describe, expect, it, vi} from 'vitest';
import {checkPluginVersions, getPluginVersionMismatches, majorOf, readPluginLock} from './plugin-lock.js';

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (() => Promise.resolve({ok, json: () => Promise.resolve(body)})) as unknown as typeof fetch;
}

const rejectingFetch = (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;

describe('readPluginLock', () => {
  it('returns the host subset for a valid lock', async () => {
    const lock = await readPluginLock(
      '/plugins/x',
      fakeFetch({
        lockVersion: 1,
        plugin: {name: 'x', version: '0.1.0'},
        framework: 'vanilla',
        sdkVersion: '2.0.0',
        sharedDependencies: {rxjs: '7.8.2'},
      }),
    );

    expect(lock).toEqual({sdkVersion: '2.0.0', sharedDependencies: {rxjs: '7.8.2'}});
  });

  it('returns null on a non-OK response', async () => {
    expect(await readPluginLock('/plugins/x', fakeFetch({}, false))).toBeNull();
  });

  it('returns null when the fetch rejects', async () => {
    expect(await readPluginLock('/plugins/x', rejectingFetch)).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const badFetch = (() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.reject(new SyntaxError('bad json')),
      })) as unknown as typeof fetch;

    expect(await readPluginLock('/plugins/x', badFetch)).toBeNull();
  });

  it('returns null on a non-object body', async () => {
    expect(await readPluginLock('/plugins/x', fakeFetch(42))).toBeNull();
  });

  it('returns null on an unsupported lockVersion', async () => {
    expect(
      await readPluginLock(
        '/plugins/x',
        fakeFetch({
          lockVersion: 2,
          sdkVersion: '2.0.0',
          sharedDependencies: {},
        }),
      ),
    ).toBeNull();
  });

  it('returns null when required fields are missing', async () => {
    expect(await readPluginLock('/plugins/x', fakeFetch({lockVersion: 1, sdkVersion: '2.0.0'}))).toBeNull();
  });

  it('returns null when sharedDependencies contains a non-string value', async () => {
    expect(
      await readPluginLock(
        '/plugins/x',
        fakeFetch({
          lockVersion: 1,
          sdkVersion: '2.0.0',
          sharedDependencies: {rxjs: 7},
        }),
      ),
    ).toBeNull();
  });
});

describe('majorOf', () => {
  it('parses a leading integer major', () => {
    expect(majorOf('7.8.2')).toBe(7);
    expect(majorOf('21.2.18')).toBe(21);
    expect(majorOf('0.2.0')).toBe(0);
    expect(majorOf('3')).toBe(3);
  });

  it('returns null for unparseable versions', () => {
    expect(majorOf('workspace:*')).toBeNull();
    expect(majorOf('^3.5.0')).toBeNull();
    expect(majorOf('foo')).toBeNull();
    expect(majorOf('')).toBeNull();
    expect(majorOf(undefined)).toBeNull();
  });
});

describe('getPluginVersionMismatches', () => {
  it('collects every shared-dep major mismatch', () => {
    expect(getPluginVersionMismatches(
      {sdkVersion: '2.0.0', sharedDependencies: {rxjs: '6.0.0', vue: '2.7.0'}},
      {rxjs: '7.8.2', vue: '3.5.39'},
      '2.0.0',
    )).toEqual([
      'rxjs @6 (host provides @7)',
      'vue @2 (host provides @3)',
    ]);
  });

  it('collects an SDK major mismatch', () => {
    expect(getPluginVersionMismatches(
      {sdkVersion: '1.9.0', sharedDependencies: {}},
      {},
      '2.0.0',
    )).toEqual(['@mndw/sdk @1 (host provides @2)']);
  });

  it('skips comparisons with an unparseable major', () => {
    expect(getPluginVersionMismatches(
      {sdkVersion: 'workspace:*', sharedDependencies: {rxjs: '^7.0.0'}},
      {rxjs: '7.8.2'},
      '2.0.0',
    )).toEqual([]);
  });

  it('skips comparisons when the host version has no parseable major', () => {
    expect(getPluginVersionMismatches(
      {sdkVersion: '2.0.0', sharedDependencies: {rxjs: '7.0.0'}},
      {rxjs: '^7.8.2'},
      'workspace:*',
    )).toEqual([]);
  });

  it('skips a specifier the host does not provide', () => {
    expect(getPluginVersionMismatches(
      {sdkVersion: '2.0.0', sharedDependencies: {'left-pad': '1.0.0'}},
      {rxjs: '7.8.2'},
      '2.0.0',
    )).toEqual([]);
  });
});

describe('checkPluginVersions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns once and returns every mismatch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mismatches = checkPluginVersions(
      'x',
      {sdkVersion: '1.9.0', sharedDependencies: {rxjs: '6.0.0'}},
      {rxjs: '7.8.2'},
      '2.0.0',
    );

    expect(mismatches).toEqual([
      'rxjs @6 (host provides @7)',
      '@mndw/sdk @1 (host provides @2)',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('rxjs');
    expect(warn.mock.calls[0][0]).toContain('@mndw/sdk');
  });

  it('does not warn and returns an empty list when all majors align', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(checkPluginVersions(
      'x',
      {sdkVersion: '2.9.9', sharedDependencies: {rxjs: '7.0.0'}},
      {rxjs: '7.8.2'},
      '2.0.0',
    )).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
