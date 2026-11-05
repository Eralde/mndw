import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

export const BUILD_VITEST_FILES: readonly string[] = [
  'build/builtin-plugins.test.ts',
  'build/catalog-versions.test.ts',
  'build/scripts/ci-test-scope.test.ts',
  'build/dev/dev.integration.test.ts',
  'build/dev/dev.test.ts',
  'build/example-plugins.test.ts',
  'build/packaging/build-ipk.test.ts',
  'build/packaging/feed-assets.test.ts',
  'build/packaging/hook-scripts.test.ts',
  'build/packaging/lifecycle-scripts.test.ts',
  'build/packaging/lighttpd-install.test.ts',
  'build/targets.test.ts',
  'build/test-build.test.ts',
];

export const BUILD_NODE_FILES: readonly string[] = [
  'build/artifacts/descriptor.test.ts',
  'build/contracts/generate-shared-deps.test.ts',
  'build/contracts/generate.test.ts',
  'build/index.test.ts',
  'build/packed-plugin-artifact.test.ts',
];

function run(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {cwd: REPO_ROOT, stdio: 'inherit'});

  if (result.error !== undefined) {
    console.error(`Failed to start ${command}:`, result.error);

    return false;
  }

  return result.status === 0;
}

function runBuildTests(): void {
  let failed = false;
  const vitestPassed = run('pnpm', [
    '--filter',
    '@mndw/palette-tools',
    'exec',
    'vitest',
    'run',
    '--root',
    '../..',
    ...BUILD_VITEST_FILES,
  ]);

  if (!vitestPassed) {
    failed = true;
  }

  for (const file of BUILD_NODE_FILES) {
    if (!run(process.execPath, ['--import', 'tsx', file])) {
      failed = true;
    }
  }

  if (!run('pnpm', ['--filter', '@mndw/ui', 'check:icons'])) {
    failed = true;
  }

  if (!run('sh', ['build/go-each-module-test.sh'])) {
    failed = true;
  }

  if (failed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBuildTests();
}
