import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const backendDir = dirname(fileURLToPath(import.meta.url));
const spawnScript = join(backendDir, 'spawn_ttyd.sh');

const writeExecutable = (path: string, content: string): void => {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
};

describe('spawn_ttyd.sh (dev path)', () => {
  it('reports ttyd not installed and exits 0 when binaries are absent', () => {
    const res = spawnSync('sh', [spawnScript], {encoding: 'utf8'});

    expect(res.status).toBe(0);

    const body = res.stdout.split(/\r?\n\r?\n/).slice(1)
      .join('\n')
      .trim();
    const parsed = JSON.parse(body) as {success: boolean; error?: string};

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/not installed/i);
  });
});

describe('spawn_ttyd.sh console selection', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mndw-ttyd-spawn-'));
  });

  afterEach(() => {
    rmSync(tempDir, {recursive: true, force: true});
  });

  const runSpawn = (input: string): string => {
    const argsFile = join(tempDir, 'daemonize-args');
    const pidFile = join(tempDir, 'ttyd.pid');
    const fakeTtyd = join(tempDir, 'ttyd');
    const fakeDaemonize = join(tempDir, 'daemonize');
    const fakeNetstat = join(tempDir, 'netstat');
    const fakeGrep = join(tempDir, 'grep');

    writeExecutable(fakeTtyd, '#!/bin/sh\nexit 0\n');
    writeExecutable(
      fakeDaemonize,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nif [ "$1" = "-p" ]; then echo 4242 > "$2"; fi\nexit 0\n`,
    );
    writeExecutable(fakeNetstat, '#!/bin/sh\nexit 0\n');
    writeExecutable(fakeGrep, '#!/bin/sh\nexit 1\n');

    spawnSync('sh', [spawnScript], {
      encoding: 'utf8',
      input,
      env: {
        ...process.env,
        MNDW_DAEMONIZE_BIN: fakeDaemonize,
        MNDW_GREP_BIN: fakeGrep,
        MNDW_NETSTAT_BIN: fakeNetstat,
        MNDW_TTYD_BIN: fakeTtyd,
        MNDW_TTYD_PID_FILE: pidFile,
      },
    });

    return `${readFileSync(argsFile, 'utf8')}|console:${readFileSync(`${pidFile}.console`, 'utf8').trim()}`;
  };

  it('passes ndmc and records router for the router console', () => {
    const out = runSpawn('{"console":"router"}');

    expect(out).toContain('ndmc');
    expect(out).toContain('console:router');
  });

  it('passes /opt/bin/sh and records entware for the entware console', () => {
    const out = runSpawn('{"console":"entware"}');

    expect(out).toContain('/opt/bin/sh');
    expect(out).toContain('console:entware');
  });

  it('falls back to ndmc for empty or malformed body', () => {
    expect(runSpawn('')).toContain('ndmc');
    expect(runSpawn('not json')).toContain('ndmc');
  });
});
