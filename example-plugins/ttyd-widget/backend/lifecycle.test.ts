import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const backendDir = dirname(fileURLToPath(import.meta.url));
const spawnScript = join(backendDir, 'spawn_ttyd.sh');
const killScript = join(backendDir, 'kill_ttyd.sh');

const writeExecutable = (path: string, content: string): void => {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
};

const responseBody = (stdout: string): Record<string, unknown> => {
  const body = stdout.split(/\r?\n\r?\n/).slice(1)
    .join('\n')
    .trim();

  return JSON.parse(body) as Record<string, unknown>;
};

const waitForFile = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      readFileSync(path);

      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`Timed out waiting for ${path}`);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const waitForExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (!isAlive(pid)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for process ${pid} to exit`);
};

describe('ttyd daemon lifecycle', () => {
  let tempDir = '';
  const processes: ReturnType<typeof spawn>[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mndw-ttyd-lifecycle-'));
  });

  afterEach(() => {
    for (const child of processes) {
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // Process already exited.
        }
      }
    }

    rmSync(tempDir, {recursive: true, force: true});
  });

  it('records and stops only the ttyd process started by the hook', async () => {
    const fakeTtyd = join(tempDir, 'ttyd');
    const fakeDaemonize = join(tempDir, 'daemonize');
    const fakeNetstat = join(tempDir, 'netstat');
    const fakeGrep = join(tempDir, 'grep');
    const pidFile = join(tempDir, 'ttyd.pid');

    writeExecutable(fakeTtyd, '#!/bin/sh\nexec sleep 30\n');
    writeExecutable(
      fakeDaemonize,
      `#!/bin/sh
if [ "$1" != "-p" ]; then exit 2; fi
pid_file="$2"
shift 2
"$@" >/dev/null 2>&1 &
echo "$!" > "$pid_file"
`,
    );
    writeExecutable(fakeNetstat, '#!/bin/sh\nexit 0\n');
    writeExecutable(fakeGrep, '#!/bin/sh\nexit 1\n');

    const env = {
      ...process.env,
      MNDW_DAEMONIZE_BIN: fakeDaemonize,
      MNDW_GREP_BIN: fakeGrep,
      MNDW_NETSTAT_BIN: fakeNetstat,
      MNDW_TTYD_BIN: fakeTtyd,
      MNDW_TTYD_PID_FILE: pidFile,
    };
    const start = spawnSync('sh', [spawnScript], {encoding: 'utf8', env});

    expect(start.status).toBe(0);
    expect(responseBody(start.stdout)).toMatchObject({success: true});
    await waitForFile(pidFile);

    const recordedPid = readFileSync(pidFile, 'utf8').trim();
    const [pid] = recordedPid.split(/\s+/);

    expect(pid).toMatch(/^\d+$/);

    const ownedPid = Number(pid);

    const unrelated = spawn('sleep', ['30'], {stdio: 'ignore'});

    processes.push(unrelated);

    if (unrelated.pid === undefined) {
      throw new Error('Failed to start unrelated process');
    }

    const stop = spawnSync('sh', [killScript], {encoding: 'utf8', env});

    expect(stop.status).toBe(0);
    expect(responseBody(stop.stdout)).toMatchObject({success: true});
    await waitForExit(ownedPid);
    expect(isAlive(unrelated.pid)).toBe(true);
  });

  it('does not stop a process when recorded PID start time does not match', () => {
    const pidFile = join(tempDir, 'ttyd.pid');
    const unrelated = spawn('sleep', ['30'], {stdio: 'ignore'});

    processes.push(unrelated);

    if (unrelated.pid === undefined) {
      throw new Error('Failed to start unrelated process');
    }

    writeFileSync(pidFile, `${unrelated.pid} 0\n`);

    const stop = spawnSync('sh', [killScript], {
      encoding: 'utf8',
      env: {...process.env, MNDW_TTYD_PID_FILE: pidFile},
    });

    expect(stop.status).toBe(0);
    expect(isAlive(unrelated.pid)).toBe(true);
  });

  it('removes stale ownership when another process already owns ttyd port', () => {
    const fakeTtyd = join(tempDir, 'ttyd');
    const fakeDaemonize = join(tempDir, 'daemonize');
    const fakeNetstat = join(tempDir, 'netstat');
    const fakeGrep = join(tempDir, 'grep');
    const pidFile = join(tempDir, 'ttyd.pid');

    writeExecutable(fakeTtyd, '#!/bin/sh\nexit 0\n');
    writeExecutable(fakeDaemonize, '#!/bin/sh\nexit 1\n');
    writeExecutable(fakeNetstat, '#!/bin/sh\nexit 0\n');
    writeExecutable(fakeGrep, '#!/bin/sh\nexit 0\n');
    writeFileSync(pidFile, '12345 0\n');

    const start = spawnSync('sh', [spawnScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MNDW_DAEMONIZE_BIN: fakeDaemonize,
        MNDW_GREP_BIN: fakeGrep,
        MNDW_NETSTAT_BIN: fakeNetstat,
        MNDW_TTYD_BIN: fakeTtyd,
        MNDW_TTYD_PID_FILE: pidFile,
      },
    });

    expect(start.status).toBe(0);
    expect(responseBody(start.stdout)).toMatchObject({success: true});
    expect(() => readFileSync(pidFile)).toThrow();
  });
});
