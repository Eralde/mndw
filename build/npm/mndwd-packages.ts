import {spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {MNDWD_PLATFORMS, type MndwdPlatform} from '../../tooling/cli/src/mndwd-platforms.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPackagePath = join(repositoryRoot, 'tooling/cli/package.json');
const daemonDir = join(repositoryRoot, 'daemon/mndwd');

interface CliPackage {
  readonly license?: string;
  readonly version?: string;
}

function readCliPackage(): CliPackage {
  return JSON.parse(readFileSync(cliPackagePath, 'utf8')) as CliPackage;
}

function cliLicense(): string {
  const license = readCliPackage().license;

  if (typeof license !== 'string' || license.length === 0) {
    throw new Error('tooling/cli/package.json must declare a license');
  }

  return license;
}

export function mndwdPackageJson(platform: MndwdPlatform, version: string): Record<string, unknown> {
  return {
    name: platform.packageName,
    version,
    files: ['bin'],
    bin: {mndwd: `./bin/${platform.binary}`},
    license: cliLicense(),
    preferUnplugged: true,
    engines: {node: '>=20.19'},
    // pnpm lifts these to the top level on pack. Keeping them out of the workspace manifest stops pnpm from
    // warning "Unsupported platform" about the four foreign packages on every command.
    publishConfig: {os: [platform.os], cpu: [platform.cpu]},
  };
}

export interface BuildMndwdPackagesOptions {
  readonly version: string;
  readonly packagesDir: string;
  readonly write?: boolean;
}

export function buildMndwdPackages(options: BuildMndwdPackagesOptions): Promise<string[]> {
  const {version, packagesDir, write = false} = options;
  const outputs: string[] = [];

  for (const platform of MNDWD_PLATFORMS) {
    const packageName = platform.packageName.replace('@mndw/', '');
    const packageDir = join(packagesDir, packageName);
    const binDir = join(packageDir, 'bin');
    const binaryPath = join(binDir, platform.binary);

    if (write) {
      mkdirSync(packageDir, {recursive: true});
      writeFileSync(
        join(packageDir, 'package.json'),
        `${JSON.stringify(mndwdPackageJson(platform, version), null, 2)}\n`,
      );
    }

    mkdirSync(binDir, {recursive: true});

    const result = spawnSync('go', [
      'build',
      '-trimpath',
      '-ldflags',
      `-s -w -X main.version=${version}`,
      '-o',
      binaryPath,
      './cmd/mndwd',
    ], {
      cwd: daemonDir,
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: platform.goos,
        GOARCH: platform.goarch,
      },
      stdio: 'inherit',
    });

    if (result.error !== undefined) {
      throw new Error(`go build failed for ${platform.packageName}: ${result.error.message}`);
    }

    if (result.signal !== null) {
      throw new Error(`go build for ${platform.packageName} terminated by signal ${result.signal}`);
    }

    if (result.status !== 0) {
      throw new Error(`go build for ${platform.packageName} exited with status ${result.status}`);
    }

    chmodSync(binaryPath, 0o755);
    outputs.push(binaryPath);
  }

  return Promise.resolve(outputs);
}

async function main(): Promise<void> {
  const version = readCliPackage().version;

  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('tooling/cli/package.json must declare a version');
  }

  await buildMndwdPackages({version, packagesDir: join(repositoryRoot, 'build/npm/mndwd'), write: true});
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
