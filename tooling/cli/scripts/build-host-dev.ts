import {cpSync, existsSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const cliRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(cliRoot, '..', '..');
const source = resolve(repoRoot, 'frontend', 'host', 'dist-dev-host');
const destination = resolve(cliRoot, 'host-dev');

const result = spawnSync('pnpm', ['--filter', '@mndw/host', 'build:dev-host'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.error !== undefined || result.status !== 0) {
  throw result.error ?? new Error('Could not build the prebuilt dev host');
}

if (!existsSync(source)) {
  throw new Error(`The dev host build did not create ${source}`);
}

rmSync(destination, {recursive: true, force: true});
cpSync(source, destination, {recursive: true});
