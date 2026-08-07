import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const backendDir = dirname(fileURLToPath(import.meta.url));

function runHook(name: string, env: Record<string, string>, stdin = ''): {stdout: string; status: number | null} {
  const res = spawnSync('sh', [join(backendDir, name)], {
    input: stdin,
    env: {...process.env, ...env},
    encoding: 'utf8',
  });

  return {stdout: res.stdout, status: res.status};
}

describe('ping-widget sh hooks', () => {
  const devEnv = {
    MNDW_PLUGIN_RUNTIME_DIR: '/tmp/ping-hooktest',
    MNDW_PING_STATE_DIR: '/tmp/ping-hooktest/state',
    REQUEST_METHOD: 'GET',
  };

  it('stats.sh emits a CGI header + JSON and exits 0 with no daemon', () => {
    const {stdout, status} = runHook('stats.sh', devEnv);

    expect(status).toBe(0);
    expect(stdout).toMatch(/^Content-Type: application\/json/);

    const body = stdout.split(/\r?\n\r?\n/).slice(1)
      .join('\n')
      .trim();

    expect(() => JSON.parse(body)).not.toThrow();
  });
});
