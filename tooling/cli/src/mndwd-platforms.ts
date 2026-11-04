export interface MndwdPlatform {
  readonly packageName: string;
  readonly os: NodeJS.Platform;
  readonly cpu: 'arm64' | 'x64';
  readonly goos: string;
  readonly goarch: string;
  readonly binary: 'mndwd' | 'mndwd.exe';
}

export const MNDWD_PLATFORMS: readonly MndwdPlatform[] = [
  {
    packageName: '@mndw/mndwd-darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    goos: 'darwin',
    goarch: 'arm64',
    binary: 'mndwd',
  },
  {
    packageName: '@mndw/mndwd-darwin-x64',
    os: 'darwin',
    cpu: 'x64',
    goos: 'darwin',
    goarch: 'amd64',
    binary: 'mndwd',
  },
  {
    packageName: '@mndw/mndwd-linux-x64',
    os: 'linux',
    cpu: 'x64',
    goos: 'linux',
    goarch: 'amd64',
    binary: 'mndwd',
  },
  {
    packageName: '@mndw/mndwd-linux-arm64',
    os: 'linux',
    cpu: 'arm64',
    goos: 'linux',
    goarch: 'arm64',
    binary: 'mndwd',
  },
  {
    packageName: '@mndw/mndwd-win32-x64',
    os: 'win32',
    cpu: 'x64',
    goos: 'windows',
    goarch: 'amd64',
    binary: 'mndwd.exe',
  },
];

export function mndwdPlatformFor(platform: NodeJS.Platform, arch: string): MndwdPlatform | undefined {
  return MNDWD_PLATFORMS.find((entry) => entry.os === platform && entry.cpu === arch);
}
