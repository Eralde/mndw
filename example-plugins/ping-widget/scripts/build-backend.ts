import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend');

// Host-arch build for dev/pack; per-arch cross-compile is Phase 8.
const result = spawnSync(
  'go',
  ['build', '-ldflags', '-s -w', '-o', 'ping-util', './cmd/ping-util'],
  {cwd: backendDir, stdio: 'inherit', env: {...process.env, CGO_ENABLED: '0'}},
);

if (result.status !== 0) {
  console.error('ping-util build failed');
  process.exit(result.status ?? 1);
}
