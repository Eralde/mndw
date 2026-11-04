import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdir, rm} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {checkTarball} from './check-tarball.js';

interface PublishedPackageSource {
  readonly name: string;
  readonly relativeDir: string;
}

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
}

export interface PackPlanPackage {
  readonly name: string;
  readonly directory: string;
  readonly tarball: string;
}

export interface PackPlan {
  readonly repositoryRoot: string;
  readonly tarballDir: string;
  readonly cleanPaths: readonly string[];
  readonly packages: readonly PackPlanPackage[];
  readonly tarballs: readonly string[];
  readonly cliTarball: string;
}

const PUBLISHED_PACKAGES: readonly PublishedPackageSource[] = [
  {name: '@mndw/mndwd-darwin-arm64', relativeDir: 'build/npm/mndwd/mndwd-darwin-arm64'},
  {name: '@mndw/mndwd-darwin-x64', relativeDir: 'build/npm/mndwd/mndwd-darwin-x64'},
  {name: '@mndw/mndwd-linux-x64', relativeDir: 'build/npm/mndwd/mndwd-linux-x64'},
  {name: '@mndw/mndwd-linux-arm64', relativeDir: 'build/npm/mndwd/mndwd-linux-arm64'},
  {name: '@mndw/mndwd-win32-x64', relativeDir: 'build/npm/mndwd/mndwd-win32-x64'},
  {name: '@mndw/palette-core', relativeDir: 'tooling/palette-core'},
  {name: '@mndw/sdk', relativeDir: 'frontend/sdk'},
  {name: '@mndw/ui', relativeDir: 'frontend/ui'},
  {name: '@mndw/ui-svelte', relativeDir: 'frontend/ui-svelte'},
  {name: '@mndw/ui-vue', relativeDir: 'frontend/ui-vue'},
  {name: '@mndw/ui-angular', relativeDir: 'frontend/ui-angular'},
  {name: '@mndw/cli', relativeDir: 'tooling/cli'},
];

const packageFilename = (name: string, version: string): string => {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
};

const readManifest = (path: string): PackageManifest => {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
};

export function createPackPlan(
  root: string,
  readJson: (path: string) => PackageManifest = readManifest,
): PackPlan {
  const repositoryRoot = resolve(root);
  const tarballDir = join(repositoryRoot, 'out/npm/tarballs');
  const packages = PUBLISHED_PACKAGES.map(({name, relativeDir}) => {
    const directory = join(repositoryRoot, relativeDir);
    const manifest = readJson(join(directory, 'package.json'));

    if (manifest.name !== name || typeof manifest.version !== 'string' || manifest.version.length === 0) {
      throw new Error(`Expected ${name} with a version in ${join(directory, 'package.json')}`);
    }

    return {name, directory, tarball: join(tarballDir, packageFilename(name, manifest.version))};
  });
  const cleanPaths = [
    tarballDir,
    ...packages.map(({directory}) => join(directory, 'dist')),
    join(repositoryRoot, 'frontend/host/dist-dev-host'),
    join(repositoryRoot, 'tooling/cli/host-dev'),
    join(repositoryRoot, 'frontend/ui/src/icon/generated'),
  ];
  const cliPackage = packages.find(({name}) => name === '@mndw/cli');

  if (cliPackage === undefined) {
    throw new Error('Pack plan is missing @mndw/cli');
  }

  return {
    repositoryRoot,
    tarballDir,
    cleanPaths,
    packages,
    tarballs: packages.map(({tarball}) => tarball),
    cliTarball: cliPackage.tarball,
  };
}

type CommandRunner = (command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => void;

const runCommand: CommandRunner = (command, args, cwd, env = process.env): void => {
  const result = spawnSync(command, [...args], {cwd, env, stdio: 'inherit'});

  if (result.error !== undefined) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}`);
  }

  if (result.signal !== null) {
    throw new Error(`${command} ${args.join(' ')} terminated by signal ${result.signal}`);
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
};

export async function packAll(options: {
  readonly repositoryRoot: string;
  readonly run?: CommandRunner;
}): Promise<PackPlan> {
  const plan = createPackPlan(options.repositoryRoot);
  const run = options.run ?? runCommand;

  for (const path of plan.cleanPaths) {
    await rm(path, {force: true, recursive: true});
  }

  await mkdir(plan.tarballDir, {recursive: true});
  run('pnpm', ['run', 'build-mndwd-npm'], plan.repositoryRoot);

  for (const pkg of plan.packages) {
    run('pnpm', ['pack', '--pack-destination', plan.tarballDir], pkg.directory);
  }

  for (const tarball of plan.tarballs) {
    const problems = await checkTarball(tarball);

    if (problems.length > 0) {
      const details = problems.map(({kind, detail}) => `  ${kind}: ${detail}`).join('\n');

      throw new Error(`${tarball} failed check-tarball:\n${details}`);
    }

    process.stdout.write(`${tarball}: no problems\n`);
  }

  run('pnpm', ['--filter', '@mndw/cli', 'exec', 'vitest', 'run', 'src/cli-tarball.test.ts'], plan.repositoryRoot, {
    ...process.env,
    MNDW_CLI_TARBALL: plan.cliTarball,
  });

  return plan;
}

const isMainModule = (url: string): boolean => {
  const entry = process.argv[1];

  return entry !== undefined && pathToFileURL(resolve(entry)).href === url;
};

if (isMainModule(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

  void packAll({repositoryRoot}).then((plan) => {
    process.stdout.write(`Packed and checked ${plan.packages.length} npm tarballs in ${plan.tarballDir}\n`);
  })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
