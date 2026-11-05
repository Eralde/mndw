import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  checkPluginVersions,
  compatibilityLevel,
  getInstallVersionWarnings,
  getPluginVersionMismatches,
  parseVersion,
  readPluginLock,
} from './plugin-lock.js';

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

describe('parseVersion', () => {
  it('parses a leading major and optional minor from trimmed versions', () => {
    expect(parseVersion('1.5.0')).toEqual({major: 1, minor: 5});
    expect(parseVersion('1.5')).toEqual({major: 1, minor: 5});
    expect(parseVersion('1.5.0-rc.1')).toEqual({major: 1, minor: 5});
    expect(parseVersion('1')).toEqual({major: 1, minor: null});
    expect(parseVersion(' 1.5.0 ')).toEqual({major: 1, minor: 5});
  });

  it('returns null for versions without a numeric prefix', () => {
    expect(parseVersion('v1.5.0')).toBeNull();
    expect(parseVersion('^1.5.0')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('garbage')).toBeNull();
  });
});

describe('compatibilityLevel', () => {
  it('uses 0.x minor as the compatibility level and major for 1.x', () => {
    expect(compatibilityLevel('0.1.0')).toBe('0.1');
    expect(compatibilityLevel('0')).toBe('0');
    expect(compatibilityLevel('1.9.0')).toBe('1');
    expect(compatibilityLevel('workspace:*')).toBeNull();
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

describe('getPluginVersionMismatches compatibility levels', () => {
  it('treats 0.x minor differences as mismatches in either direction', () => {
    expect(getPluginVersionMismatches(
      {sdkVersion: '0.1.0', sharedDependencies: {}},
      {},
      '0.2.0',
    )).toEqual(['@mndw/sdk @0.1 (host provides @0.2)']);

    expect(getPluginVersionMismatches(
      {sdkVersion: '0.2.0', sharedDependencies: {}},
      {},
      '0.1.0',
    )).toEqual(['@mndw/sdk @0.2 (host provides @0.1)']);
  });

  it('keeps equal positive majors compatible and treats zero-to-one as a mismatch', () => {
    expect(getPluginVersionMismatches(
      {sdkVersion: '1.2.0', sharedDependencies: {}},
      {},
      '1.9.0',
    )).toEqual([]);

    expect(getPluginVersionMismatches(
      {sdkVersion: '0.1.0', sharedDependencies: {}},
      {},
      '1.0.0',
    )).toEqual(['@mndw/sdk @0.1 (host provides @1)']);
  });

  it('reports 0.x shared dependency minor differences', () => {
    expect(getPluginVersionMismatches(
      {sdkVersion: '0.1.0', sharedDependencies: {rxjs: '0.1.0'}},
      {rxjs: '0.2.0'},
      '0.1.0',
    )).toEqual(['rxjs @0.1 (host provides @0.2)']);
  });
});

describe('getInstallVersionWarnings', () => {
  const hostVersions = {rxjs: '7.8.2'};
  const hostSdkVersion = '1.3.0';

  it('warns when SDK major differs', () => {
    expect(getInstallVersionWarnings(
      {sdkVersion: '2.0.0', sharedDependencies: {}},
      hostVersions,
      hostSdkVersion,
    )).toEqual([{kind: 'sdk-major', name: '@mndw/sdk', pluginVersion: '2.0.0', hostVersion: '1.3.0'}]);
  });

  it('warns when plugin uses newer minor of same SDK major', () => {
    expect(getInstallVersionWarnings(
      {sdkVersion: '1.5.0', sharedDependencies: {}},
      hostVersions,
      hostSdkVersion,
    )).toEqual([{kind: 'sdk-newer-minor', name: '@mndw/sdk', pluginVersion: '1.5.0', hostVersion: '1.3.0'}]);
  });

  it('does not warn for an older minor of the same SDK major', () => {
    expect(getInstallVersionWarnings(
      {sdkVersion: '1.1.0', sharedDependencies: {}},
      hostVersions,
      hostSdkVersion,
    )).toEqual([]);
  });

  it('warns for an older SDK major', () => {
    expect(getInstallVersionWarnings(
      {sdkVersion: '0.9.0', sharedDependencies: {}},
      hostVersions,
      hostSdkVersion,
    )).toEqual([{kind: 'sdk-major', name: '@mndw/sdk', pluginVersion: '0.9.0', hostVersion: '1.3.0'}]);
  });

  it('warns when a shared dependency major differs', () => {
    expect(getInstallVersionWarnings(
      {sdkVersion: '1.3.0', sharedDependencies: {rxjs: '8.0.0'}},
      hostVersions,
      hostSdkVersion,
    )).toEqual([{kind: 'shared-major', name: 'rxjs', pluginVersion: '8.0.0', hostVersion: '7.8.2'}]);
  });

  it('skips a specifier the host does not provide', () => {
    expect(getInstallVersionWarnings(
      {sdkVersion: '1.3.0', sharedDependencies: {'left-pad': '2.0.0'}},
      hostVersions,
      hostSdkVersion,
    )).toEqual([]);
  });

  it('skips unparsable SDK versions without suppressing shared dependency warnings', () => {
    for (const sdkVersion of ['garbage', '', 'v2.0.0']) {
      expect(getInstallVersionWarnings(
        {sdkVersion, sharedDependencies: {rxjs: '8.0.0'}},
        hostVersions,
        hostSdkVersion,
      )).toEqual([{kind: 'shared-major', name: 'rxjs', pluginVersion: '8.0.0', hostVersion: '7.8.2'}]);
    }
  });

  it('skips a missing minor and still checks major mismatches', () => {
    expect(getInstallVersionWarnings(
      {sdkVersion: '1', sharedDependencies: {}},
      hostVersions,
      hostSdkVersion,
    )).toEqual([]);
    expect(getInstallVersionWarnings(
      {sdkVersion: '2', sharedDependencies: {}},
      hostVersions,
      hostSdkVersion,
    )).toEqual([{kind: 'sdk-major', name: '@mndw/sdk', pluginVersion: '2', hostVersion: '1.3.0'}]);
  });

  it('skips the SDK comparison when the host SDK version is unparsable', () => {
    expect(getInstallVersionWarnings(
      {sdkVersion: '2.0.0', sharedDependencies: {}},
      hostVersions,
      'garbage',
    )).toEqual([]);
  });
});

describe('getInstallVersionWarnings compatibility levels', () => {
  const hostVersions = {rxjs: '7.8.2'};

  it('keeps 1.x minor warnings and warns for differing 0.x SDK and shared levels', () => {
    expect(getInstallVersionWarnings(
      {sdkVersion: '1.2.0', sharedDependencies: {}},
      hostVersions,
      '1.9.0',
    )).toEqual([]);

    expect(getInstallVersionWarnings(
      {sdkVersion: '1.9.0', sharedDependencies: {}},
      hostVersions,
      '1.2.0',
    )).toEqual([{kind: 'sdk-newer-minor', name: '@mndw/sdk', pluginVersion: '1.9.0', hostVersion: '1.2.0'}]);

    expect(getInstallVersionWarnings(
      {sdkVersion: '0.1.0', sharedDependencies: {rxjs: '0.1.0'}},
      {rxjs: '0.2.0'},
      '0.2.0',
    )).toEqual([
      {kind: 'sdk-major', name: '@mndw/sdk', pluginVersion: '0.1.0', hostVersion: '0.2.0'},
      {kind: 'shared-major', name: 'rxjs', pluginVersion: '0.1.0', hostVersion: '0.2.0'},
    ]);
  });
});

describe('0.x patch compatibility', () => {
  it('keeps SDK and shared dependency versions in the same minor compatible', () => {
    const lock = {sdkVersion: '0.1.0', sharedDependencies: {rxjs: '0.1.0'}};
    const hostVersions = {rxjs: '0.1.5'};

    expect(getPluginVersionMismatches(lock, hostVersions, '0.1.5')).toEqual([]);
    expect(getInstallVersionWarnings(lock, hostVersions, '0.1.5')).toEqual([]);
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
