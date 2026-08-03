import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const builds = [
  ['mwsd', './cmd/mwsd'],
  ['mwsd-client', './cmd/mwsd-client'],
] as const;

for (const [output, packagePath] of builds) {
  const result = spawnSync('go', ['build', '-ldflags', '-s -w', '-o', output, packagePath], {
    cwd: backendDir,
    stdio: 'inherit',
    env: {...process.env, CGO_ENABLED: '0'},
  });

  if (result.status !== 0) {
    console.error(`${output} build failed`);
    process.exit(result.status ?? 1);
  }
}
