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

  it('polls for the ttyd port to be released before returning', () => {
    const grepCalls = join(tempDir, 'grep-calls');
    const fakeNetstat = join(tempDir, 'netstat');
    const fakeGrep = join(tempDir, 'grep');

    writeExecutable(fakeNetstat, '#!/bin/sh\nexit 0\n');
    writeExecutable(
      fakeGrep,
      `#!/bin/sh
f="${grepCalls}"
n=0
[ -f "$f" ] && n="$(cat "$f")"
n=$((n + 1))
echo "$n" > "$f"
if [ "$n" -le 2 ]; then exit 0; else exit 1; fi
`,
    );

    // No pid-file -> nothing to kill, but the port poll still runs. grep reports
    // "listening" for the first 2 checks, then "released" -> the loop stops early.
    const stop = spawnSync('sh', [killScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MNDW_TTYD_PID_FILE: join(tempDir, 'ttyd.pid'),
        MNDW_NETSTAT_BIN: fakeNetstat,
        MNDW_GREP_BIN: fakeGrep,
      },
    });

    expect(stop.status).toBe(0);
    expect(responseBody(stop.stdout)).toMatchObject({success: true});
    expect(Number(readFileSync(grepCalls, 'utf8').trim())).toBe(3);
  });

  it('restarts ttyd via kill_ttyd.sh when the running console differs', async () => {
    const argsFile = join(tempDir, 'daemonize-args');
    const grepCalls = join(tempDir, 'grep-calls');
    const pidFile = join(tempDir, 'ttyd.pid');
    const fakeTtyd = join(tempDir, 'ttyd');
    const fakeDaemonize = join(tempDir, 'daemonize');
    const fakeNetstat = join(tempDir, 'netstat');
    const fakeGrep = join(tempDir, 'grep');

    writeExecutable(fakeTtyd, '#!/bin/sh\nexec sleep 30\n');
    writeExecutable(
      fakeDaemonize,
      `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
if [ "$1" != "-p" ]; then exit 2; fi
pid_file="$2"
shift 2
"$@" >/dev/null 2>&1 &
echo "$!" > "$pid_file"
`,
    );
    writeExecutable(fakeNetstat, '#!/bin/sh\nexit 0\n');

    const env = {
      ...process.env,
      MNDW_DAEMONIZE_BIN: fakeDaemonize,
      MNDW_GREP_BIN: fakeGrep,
      MNDW_NETSTAT_BIN: fakeNetstat,
      MNDW_TTYD_BIN: fakeTtyd,
      MNDW_TTYD_PID_FILE: pidFile,
    };

    // Phase 1: port free, console router -> the script writes an owned pid-file + sidecar.
    writeExecutable(fakeGrep, '#!/bin/sh\nexit 1\n');

    const first = spawnSync('sh', [spawnScript], {encoding: 'utf8', input: '{"console":"router"}', env});

    expect(responseBody(first.stdout)).toMatchObject({success: true});
    await waitForFile(pidFile);

    const firstPid = Number(readFileSync(pidFile, 'utf8').trim()
.split(/\s+/)[0]);

    expect(readFileSync(`${pidFile}.console`, 'utf8').trim()).toBe('router');

    // Phase 2: stateful grep — "listening" for spawn's own port check (call 1),
    // "released" for kill_ttyd.sh's poll (call 2+). Console entware -> restart.
    writeExecutable(
      fakeGrep,
      `#!/bin/sh
f="${grepCalls}"
n=0
[ -f "$f" ] && n="$(cat "$f")"
n=$((n + 1))
echo "$n" > "$f"
if [ "$n" -eq 1 ]; then exit 0; else exit 1; fi
`,
    );

    const second = spawnSync('sh', [spawnScript], {encoding: 'utf8', input: '{"console":"entware"}', env});

    expect(responseBody(second.stdout)).toMatchObject({success: true});
    await waitForExit(firstPid);
    expect(readFileSync(argsFile, 'utf8')).toContain('/opt/bin/sh');
    expect(readFileSync(`${pidFile}.console`, 'utf8').trim()).toBe('entware');

    const secondPid = Number(readFileSync(pidFile, 'utf8').trim()
.split(/\s+/)[0]);

    try {
      process.kill(secondPid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  });
});
