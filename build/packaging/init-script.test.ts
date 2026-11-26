import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {type ChildProcess, spawn} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const initScript = path.join(repoRoot, 'build', 'packaging', 'init', 'S70mndwd');
const fixtures: string[] = [];
const children: ChildProcess[] = [];
const extraPids: number[] = [];

interface InitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface SpawnedSleep {
  child: ChildProcess;
  pid: number;
}

const writeExecutable = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
};

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mndw-init-pid-test-'));

  fixtures.push(root);
  fs.mkdirSync(path.join(root, 'proc'), {recursive: true});
  fs.mkdirSync(path.join(root, 'var', 'run'), {recursive: true});
  writeExecutable(path.join(root, 'bin', 'device-port-helper'), '#!/bin/sh\nprintf \'80\\n\'\n');
  writeExecutable(path.join(root, 'bin', 'ip'), '#!/bin/sh\nprintf \'inet 192.0.2.10/24 br0\\n\'\n');
  writeExecutable(
    path.join(root, 'bin', 'logger'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$MNDW_TEST_LOGGER_FILE"\n',
  );
  writeExecutable(
    path.join(root, 'sbin', 'mndwd'),
    '#!/bin/sh\n'
      + 'if [ "${1:-}" = --version ]; then\n'
      + '  [ "${FAKE_DAEMON_VERSION_MODE:-}" != fail ] || exit 1\n'
      + '  [ "${FAKE_DAEMON_VERSION_MODE:-}" != empty ] || exit 0\n'
      + '  printf \'%s\\n\' "${FAKE_DAEMON_VERSION:-mndwd test version}" extra\n'
      + '  exit 0\n'
      + 'fi\n'
      + 'printf \'8080\\n\' > "$MNDW_PORT_FILE.tmp"\n'
      + 'mv "$MNDW_PORT_FILE.tmp" "$MNDW_PORT_FILE"\n'
      + 'printf \'%s\\n\' "$*" > "$MNDW_ROOT/daemon-args"\n'
      + 'printf \'daemon stdout\\n\'\n'
      + 'printf \'daemon stderr\\n\' >&2\n'
      + 'printf \'started\\n\' >> "$MNDW_ROOT/started"\n'
      + 'exec sleep 30\n',
  );

  return root;
};

const pidFile = (root: string): string => path.join(root, 'var', 'run', 'mndwd.pid');

const writePid = (root: string, pid: number): void => {
  fs.mkdirSync(path.dirname(pidFile(root)), {recursive: true});
  fs.writeFileSync(pidFile(root), `${pid}\n`);
};

const writeProcCmdline = (root: string, pid: number, args: string[]): void => {
  const directory = path.join(root, 'proc', `${pid}`);

  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'cmdline'), args.length === 0 ? '' : `${args.join('\0')}\0`);
};

const testEnvironment = (root: string, useRealProc = false): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MNDW_ROOT: root,
    MNDW_CONFIG_FILE: path.join(root, 'missing-mndw.conf'),
    MNDW_DEVICE_PORT_HELPER: path.join(root, 'bin', 'device-port-helper'),
    MNDW_TEST_LOGGER_FILE: path.join(root, 'logger.log'),
    PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
  };

  if (useRealProc) {
    delete env.MNDW_PROC_ROOT;
  } else {
    env.MNDW_PROC_ROOT = path.join(root, 'proc');
  }

  return env;
};

const runInit = (
  root: string,
  action: string,
  useRealProc = false,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<InitResult> => {
  return new Promise((resolvePromise) => {
    const child = spawn('/bin/sh', [initScript, action], {
      cwd: repoRoot,
      env: {...testEnvironment(root, useRealProc), ...extraEnv},
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    children.push(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 5000);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timeout);
      resolvePromise({code: null, signal: null, stdout, stderr, timedOut});
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({code, signal, stdout, stderr, timedOut});
    });
  });
};

const spawnSleep = async (): Promise<SpawnedSleep> => {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('sleep', ['30'], {stdio: 'ignore'});

    children.push(child);
    child.once('error', rejectPromise);
    child.once('spawn', () => {
      if (child.pid === undefined) {
        rejectPromise(new Error('sleep did not receive a PID'));

        return;
      }

      resolvePromise({child, pid: child.pid});
    });
  });
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const waitForExit = (child: ChildProcess, timeoutMs = 5000): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      resolvePromise(false);
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolvePromise(true);
    });
  });
};

const waitForPidExit = async (pid: number, timeoutMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }

  return !isAlive(pid);
};

const stopProcess = async (pid: number): Promise<void> => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }

  await waitForPidExit(pid, 1000);
};

afterEach(async () => {
  const pids = new Set(extraPids.splice(0));

  for (const root of fixtures) {
    try {
      const contents = fs.readFileSync(pidFile(root), 'utf8').trim();

      if (/^[0-9]+$/.test(contents)) {
        pids.add(Number(contents));
      }
    } catch {
      // No PID file was left by this test.
    }
  }

  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      await stopProcess(child.pid);
    }
  }

  for (const pid of pids) {
    await stopProcess(pid);
  }

  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

describe('S70mndwd pid file', () => {
  it('stop ignores a live foreign process', async () => {
    const root = makeRoot();
    const foreign = await spawnSleep();

    writePid(root, foreign.pid);
    writeProcCmdline(root, foreign.pid, ['sleep', '30']);

    const result = await runInit(root, 'stop');

    expect(result.timedOut).toBe(false);
    expect(result.code, result.stderr).toBe(0);
    expect(isAlive(foreign.pid)).toBe(true);
    expect(fs.existsSync(pidFile(root))).toBe(false);
    expect(result.stderr).toContain('ignoring stale pid file');
  });

  it('stop ignores a backend process even when its executable is mndwd', async () => {
    const root = makeRoot();
    const backend = await spawnSleep();

    writePid(root, backend.pid);
    writeProcCmdline(root, backend.pid, [path.join(root, 'sbin', 'mndwd'), 'backend', 'mwsd']);

    const result = await runInit(root, 'stop');

    expect(result.timedOut).toBe(false);
    expect(result.code, result.stderr).toBe(0);
    expect(isAlive(backend.pid)).toBe(true);
    expect(fs.existsSync(pidFile(root))).toBe(false);
    expect(result.stderr).toContain('ignoring stale pid file');
  });

  it('stop ignores a kernel thread', async () => {
    const root = makeRoot();
    const foreign = await spawnSleep();

    writePid(root, foreign.pid);
    writeProcCmdline(root, foreign.pid, []);

    const result = await runInit(root, 'stop');

    expect(result.timedOut).toBe(false);
    expect(result.code, result.stderr).toBe(0);
    expect(isAlive(foreign.pid)).toBe(true);
    expect(fs.existsSync(pidFile(root))).toBe(false);
    expect(result.stderr).toContain('ignoring stale pid file');
  });

  it('stop terminates the real daemon', async () => {
    const root = makeRoot();
    const daemon = await spawnSleep();

    writePid(root, daemon.pid);
    writeProcCmdline(root, daemon.pid, [path.join(root, 'sbin', 'mndwd'), '--data-dir', 'x']);

    const result = await runInit(root, 'stop');

    expect(result.code, result.stderr).toBe(0);
    expect(await waitForExit(daemon.child)).toBe(true);
    expect(fs.existsSync(pidFile(root))).toBe(false);
  });

  it('stop clears a dead pid', async () => {
    const root = makeRoot();
    const dead = await spawnSleep();

    extraPids.push(dead.pid);
    dead.child.kill('SIGKILL');
    expect(await waitForExit(dead.child)).toBe(true);
    writePid(root, dead.pid);

    const result = await runInit(root, 'stop');

    expect(result.code, result.stderr).toBe(0);
    expect(fs.existsSync(pidFile(root))).toBe(false);
  });

  it.runIf(fs.existsSync('/proc/self/cmdline'))('stop ignores a foreign process with the real /proc', async () => {
    const root = makeRoot();
    const foreign = await spawnSleep();

    writePid(root, foreign.pid);
    extraPids.push(foreign.pid);

    const result = await runInit(root, 'stop', true);

    expect(result.timedOut).toBe(false);
    expect(result.code, result.stderr).toBe(0);
    expect(isAlive(foreign.pid)).toBe(true);
  });

  it('start launches the daemon when a foreign process holds the pid', async () => {
    const root = makeRoot();
    const foreign = await spawnSleep();

    writePid(root, foreign.pid);
    writeProcCmdline(root, foreign.pid, ['sleep', '30']);

    const result = await runInit(root, 'start');
    const daemonPid = Number(fs.readFileSync(pidFile(root), 'utf8').trim());

    expect(result.timedOut).toBe(false);
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, 'started'), 'utf8')).toBe('started\n');
    expect(daemonPid).not.toBe(foreign.pid);
    expect(isAlive(foreign.pid)).toBe(true);
    expect(result.stderr).toContain('mndw dashboard:');
    expect(result.stderr).toContain('ignoring stale pid file');
  });

  it('uses the RAM log and keeps only the previous crash trace', async () => {
    const root = makeRoot();
    const crashLog = path.join(root, 'var', 'log', 'mndwd.crash.log');
    const legacyLog = path.join(root, 'var', 'log', 'mndwd.log');
    const initSource = fs.readFileSync(initScript, 'utf8');

    fs.mkdirSync(path.dirname(crashLog), {recursive: true});
    fs.writeFileSync(crashLog, 'stale crash output\n');
    fs.writeFileSync(`${crashLog}.1`, 'older backup\n');

    const firstStart = await runInit(root, 'start');

    expect(firstStart.code, firstStart.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, 'daemon-args'), 'utf8')).toContain('--log-file /tmp/mndwd.log');
    expect(fs.readFileSync(crashLog, 'utf8')).toContain('daemon stdout\n');
    expect(fs.readFileSync(crashLog, 'utf8')).toContain('daemon stderr\n');
    expect(fs.readFileSync(crashLog, 'utf8')).not.toContain('stale crash output');
    expect(fs.readFileSync(`${crashLog}.1`, 'utf8')).toBe('stale crash output\n');
    expect(fs.existsSync(legacyLog)).toBe(false);
    expect(initSource).toContain('> "$CRASH_LOG_FILE" 2>&1 &');
    expect(initSource).not.toContain('>> "$CRASH_LOG_FILE" 2>&1 &');

    const firstPid = Number(fs.readFileSync(pidFile(root), 'utf8').trim());

    await stopProcess(firstPid);
    fs.rmSync(pidFile(root), {force: true});
    fs.writeFileSync(crashLog, 'stale crash output from previous start\n');

    const secondStart = await runInit(root, 'start');

    expect(secondStart.code, secondStart.stderr).toBe(0);
    expect(fs.readFileSync(crashLog, 'utf8')).toContain('daemon stdout\n');
    expect(fs.readFileSync(crashLog, 'utf8')).toContain('daemon stderr\n');
    expect(fs.readFileSync(crashLog, 'utf8')).not.toContain('stale crash output');
    expect(fs.readFileSync(`${crashLog}.1`, 'utf8')).toBe('stale crash output from previous start\n');

    const secondPid = Number(fs.readFileSync(pidFile(root), 'utf8').trim());

    await stopProcess(secondPid);
    fs.rmSync(pidFile(root), {force: true});
  });

  it('start leaves a running daemon alone', async () => {
    const root = makeRoot();
    const daemon = await spawnSleep();

    writePid(root, daemon.pid);
    writeProcCmdline(root, daemon.pid, [path.join(root, 'sbin', 'mndwd'), '--data-dir', 'x']);

    const result = await runInit(root, 'start');

    expect(result.code, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, 'started'))).toBe(false);
    expect(fs.readFileSync(pidFile(root), 'utf8')).toBe(`${daemon.pid}\n`);
  });
});

describe('S70mndwd start readiness', () => {
  it('retries transient device-port detection until it succeeds', async () => {
    const root = makeRoot();
    const helper = path.join(root, 'bin', 'device-port-helper');

    writeExecutable(
      helper,
      `#!/bin/sh
count=$(cat "$MNDW_ROOT/helper-count" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s\n' "$count" > "$MNDW_ROOT/helper-count"
printf 'probe-%s\n' "$count" >&2
if [ "$count" -lt 3 ]; then exit 3; fi
printf '80\n'
`,
    );

    const result = await runInit(root, 'start', false, {
      MNDW_START_WAIT_SECONDS: '2',
      MNDW_START_RETRY_INTERVAL: '0',
    });

    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, 'helper-count'), 'utf8')).toBe('3\n');
    expect(result.stderr).not.toContain('probe-');
  });

  it('forwards only the last transient probe output when the wait expires', async () => {
    const root = makeRoot();
    const helper = path.join(root, 'bin', 'device-port-helper');
    const date = path.join(root, 'bin', 'date');

    writeExecutable(
      helper,
      `#!/bin/sh
count=$(cat "$MNDW_ROOT/helper-count" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s\n' "$count" > "$MNDW_ROOT/helper-count"
printf 'probe-%s\n' "$count" >&2
exit 3
`,
    );
    writeExecutable(
      date,
      `#!/bin/sh
count=$(cat "$MNDW_ROOT/date-count" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s\n' "$count" > "$MNDW_ROOT/date-count"
case "$count" in
  1|2|3) printf '100\n' ;;
  4) printf '101\n' ;;
  *) printf '102\n' ;;
esac
`,
    );

    const result = await runInit(root, 'start', false, {
      MNDW_START_WAIT_SECONDS: '2',
      MNDW_START_RETRY_INTERVAL: '0',
    });
    const attempts = Number(fs.readFileSync(path.join(root, 'helper-count'), 'utf8').trim());

    expect(result.code).toBe(1);
    expect(attempts).toBeGreaterThan(0);
    expect(result.stderr.trim().split('\n')).toEqual([`probe-${attempts}`]);
  });
});

describe('S70mndwd permanent start failures and IP readiness', () => {
  it('does not retry a permanent device-port detection failure', async () => {
    const root = makeRoot();
    const helper = path.join(root, 'bin', 'device-port-helper');

    writeExecutable(
      helper,
      `#!/bin/sh
count=$(cat "$MNDW_ROOT/helper-count" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s\n' "$count" > "$MNDW_ROOT/helper-count"
printf 'broken configuration\n' >&2
exit 1
`,
    );

    const result = await runInit(root, 'start', false, {
      MNDW_START_WAIT_SECONDS: '2',
      MNDW_START_RETRY_INTERVAL: '0',
    });

    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe('broken configuration');
    expect(fs.readFileSync(path.join(root, 'helper-count'), 'utf8')).toBe('1\n');
  });

  it('waits for br0 IPv4 and passes the address that appears to the daemon', async () => {
    const root = makeRoot();
    const ip = path.join(root, 'bin', 'ip');
    const helper = path.join(root, 'bin', 'device-port-helper');

    writeExecutable(
      ip,
      `#!/bin/sh
count=$(cat "$MNDW_ROOT/ip-count" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s\n' "$count" > "$MNDW_ROOT/ip-count"
if [ "$count" -gt 1 ]; then printf 'inet 192.0.2.42/24 br0\n'; fi
`,
    );
    writeExecutable(
      helper,
      '#!/bin/sh\nprintf \'%s\\n\' "$2" > "$MNDW_ROOT/detected-ip"\nprintf \'80\\n\'\n',
    );

    const result = await runInit(root, 'start', false, {
      MNDW_START_WAIT_SECONDS: '2',
      MNDW_START_RETRY_INTERVAL: '0',
    });

    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, 'detected-ip'), 'utf8')).toBe('192.0.2.42\n');
    expect(fs.readFileSync(path.join(root, 'daemon-args'), 'utf8')).toContain('--device-url http://192.0.2.42');
  });
});

describe('S70mndwd start logging and already-running behavior', () => {
  it('logs start failures through logger', async () => {
    const root = makeRoot();

    const result = await runInit(root, 'start', false, {
      MNDW_DEVICE_PORT_HELPER: path.join(root, 'missing-helper'),
    });

    expect(result.code).toBe(1);
    expect(fs.readFileSync(path.join(root, 'logger.log'), 'utf8')).toContain(
      `-t mndw mndw: missing device port helper: ${path.join(root, 'missing-helper')}`,
    );
  });

  it('checks for a running daemon before calling the helper', async () => {
    const root = makeRoot();
    const daemon = await spawnSleep();
    const helper = path.join(root, 'bin', 'device-port-helper');

    writePid(root, daemon.pid);
    writeProcCmdline(root, daemon.pid, [path.join(root, 'sbin', 'mndwd')]);
    writeExecutable(helper, '#!/bin/sh\nprintf called > "$MNDW_ROOT/helper-called"\nexit 1\n');

    const result = await runInit(root, 'start');

    expect(result.code, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, 'helper-called'))).toBe(false);
  });
});

describe('S70mndwd status', () => {
  it('reports a running daemon, first version line, and dashboard URL', async () => {
    const root = makeRoot();
    const daemon = await spawnSleep();

    writePid(root, daemon.pid);
    writeProcCmdline(root, daemon.pid, [path.join(root, 'sbin', 'mndwd')]);
    fs.mkdirSync(path.join(root, 'var', 'lib', 'mndw'), {recursive: true});
    fs.writeFileSync(path.join(root, 'var', 'lib', 'mndw', 'frontend-port'), '8088\n');

    const result = await runInit(root, 'status');

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`mndwd is running (pid ${daemon.pid})\n`);
    expect(result.stdout).toContain('version: mndwd test version\n');
    expect(result.stdout).not.toContain('extra');
    expect(result.stdout).toContain('dashboard: http://192.0.2.10:8088/\n');
  });

  it('omits unavailable version and dashboard details without changing state', async () => {
    const root = makeRoot();
    const daemon = await spawnSleep();
    const ip = path.join(root, 'bin', 'ip');

    writePid(root, daemon.pid);
    writeProcCmdline(root, daemon.pid, [path.join(root, 'sbin', 'mndwd')]);
    writeExecutable(ip, '#!/bin/sh\nexit 0\n');

    const result = await runInit(root, 'status', false, {FAKE_DAEMON_VERSION_MODE: 'fail'});

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`mndwd is running (pid ${daemon.pid})`);
    expect(fs.existsSync(path.join(root, 'var', 'lib', 'mndw'))).toBe(false);
  });

  it('reports stale pid files and leaves them in place', async () => {
    const root = makeRoot();
    const foreign = await spawnSleep();
    const crashLog = path.join(root, 'var', 'log', 'mndwd.crash.log');

    writePid(root, foreign.pid);
    writeProcCmdline(root, foreign.pid, ['sleep', '30']);
    fs.mkdirSync(path.dirname(crashLog), {recursive: true});
    fs.writeFileSync(crashLog, 'previous crash\n');

    const result = await runInit(root, 'status');

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`mndwd is not running (stale pid file ${pidFile(root)})\n`);
    expect(result.stdout).toContain(`logs: ${crashLog}`);
    expect(fs.readFileSync(pidFile(root), 'utf8')).toBe(`${foreign.pid}\n`);
  });

  it('returns LSB status 3 with no pid file and gives check the same result', async () => {
    const root = makeRoot();

    for (const action of ['status', 'check']) {
      const result = await runInit(root, action);

      expect(result.code).toBe(3);
      expect(result.stdout.trim()).toBe('mndwd is not running');
    }

    expect(fs.existsSync(path.join(root, 'var', 'lib', 'mndw'))).toBe(false);
  });
});
