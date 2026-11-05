import {appendFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export type TestScope = 'full' | 'affected';

export const selectTestScope = (changedFiles: readonly string[], packageDirs: readonly string[]): TestScope => {
  const relevantFiles = changedFiles.filter((file) => !file.startsWith('docs/') && !file.endsWith('.md'));

  return relevantFiles.every((file) => packageDirs.some((packageDir) => file.startsWith(`${packageDir}/`)))
    ? 'affected'
    : 'full';
};

const run = (command: string, args: string[]): string => {
  const result = spawnSync(command, args, {cwd: REPO_ROOT, encoding: 'utf8'});

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}: ${result.stderr.trim()}`);
  }

  return result.stdout;
};

const getPackageDirs = (): string[] => {
  const output = JSON.parse(run('pnpm', ['ls', '-r', '--depth', '-1', '--json'])) as unknown;

  if (!Array.isArray(output)) {
    throw new Error('pnpm ls did not return a package array');
  }

  return output.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('path' in entry) || typeof entry.path !== 'string') {
      throw new Error('pnpm ls returned a package without a path');
    }

    const directory = relative(REPO_ROOT, resolve(REPO_ROOT, entry.path))
      .split(sep)
      .join('/');

    return directory === '' ? [] : [directory];
  });
};

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const writeScope = (scope: TestScope, reason: string): void => {
  console.log(`scope=${scope}`);
  console.log(reason);

  const outputPath = process.env.GITHUB_OUTPUT;

  if (outputPath !== undefined) {
    try {
      appendFileSync(outputPath, `scope=${scope}\n`);
    } catch (error) {
      console.error(`Could not write GITHUB_OUTPUT: ${errorMessage(error)}`);
    }
  }
};

const runCiTestScope = (): void => {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    writeScope('full', 'full scope because GITHUB_EVENT_NAME is not pull_request');

    return;
  }

  try {
    const revisions = run('git', ['rev-list', '--parents', '-n', '1', 'HEAD'])
      .trim()
      .split(/\s+/);

    if (revisions.length !== 3) {
      const parentCount = Math.max(revisions.length - 1, 0);

      writeScope('full', `full scope because HEAD has ${parentCount} parent(s); expected a two-parent merge commit`);

      return;
    }

    const changedFiles = run('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'])
      .split('\n')
      .filter(Boolean)
      .map((file) => file.replace(/\\/g, '/'));
    const packageDirs = getPackageDirs();
    const scope = selectTestScope(changedFiles, packageDirs);
    const relevantFiles = changedFiles.filter((file) => !file.startsWith('docs/') && !file.endsWith('.md'));
    const firstOutsidePackage = relevantFiles.find(
      (file) => !packageDirs.some((packageDir) => file.startsWith(`${packageDir}/`)),
    );

    writeScope(
      scope,
      firstOutsidePackage === undefined
        ? 'affected scope because all changed files are in workspace packages or ignored'
        : `full scope because ${firstOutsidePackage} is outside all workspace packages`,
    );
  } catch (error) {
    writeScope('full', `full scope because scope detection failed: ${errorMessage(error)}`);
  }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCiTestScope();
}
