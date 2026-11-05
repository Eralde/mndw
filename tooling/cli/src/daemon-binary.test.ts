import {describe, expect, it} from 'vitest';

import {resolvePackagedDaemon} from './daemon-binary.js';

describe('resolvePackagedDaemon', () => {
  it('returns the selected platform package binary', () => {
    const result = resolvePackagedDaemon({
      platform: 'linux',
      arch: 'arm64',
      resolve: () => '/project/node_modules/@mndw/mndwd-linux-arm64/package.json',
    });

    expect(result).toBe('/project/node_modules/@mndw/mndwd-linux-arm64/bin/mndwd');
  });

  it('uses the Windows executable name', () => {
    const result = resolvePackagedDaemon({
      platform: 'win32',
      arch: 'x64',
      resolve: () => '/project/node_modules/@mndw/mndwd-win32-x64/package.json',
    });

    expect(result).toBe('/project/node_modules/@mndw/mndwd-win32-x64/bin/mndwd.exe');
  });

  it('lists supported platforms for an unsupported target', () => {
    expect(() => resolvePackagedDaemon({platform: 'freebsd', arch: 'x64'})).toThrow(/supported:/);
  });

  it('explains how to repair a missing platform package', () => {
    expect(() =>
      resolvePackagedDaemon({
        platform: 'linux',
        arch: 'arm64',
        resolve: () => {
          throw new Error('missing');
        },
      })
    ).toThrow(/@mndw\/mndwd-linux-arm64 is not installed/);
  });
});
