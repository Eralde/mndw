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
  writeExecutable(
    path.join(root, 'sbin', 'mndwd'),
    '#!/bin/sh\nprintf \'8080\\n\' > "$MNDW_PORT_FILE"\n'
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
  };

  if (useRealProc) {
    delete env.MNDW_PROC_ROOT;
  } else {
    env.MNDW_PROC_ROOT = path.join(root, 'proc');
  }

  return env;
};

const runInit = (root: string, action: 'start' | 'stop', useRealProc = false): Promise<InitResult> => {
  return new Promise((resolvePromise) => {
    const child = spawn('/bin/sh', [initScript, action], {
      cwd: repoRoot,
      env: testEnvironment(root, useRealProc),
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
