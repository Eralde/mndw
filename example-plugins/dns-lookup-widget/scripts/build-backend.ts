import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend');

// Host-arch build for dev/pack/tests. Per-arch cross-compile is handled by
// the central IPK pipeline (tools/build-ipk.ts:crossCompilePluginBackends).
const result = spawnSync(
  'go',
  ['build', '-ldflags', '-s -w', '-o', 'dns-util', './cmd/dns-util'],
  {cwd: backendDir, stdio: 'inherit', env: {...process.env, CGO_ENABLED: '0'}},
);

if (result.status !== 0) {
  console.error('dns-util build failed');
  process.exit(result.status ?? 1);
}
