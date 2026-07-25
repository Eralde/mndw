import {execFile as nodeExecFile, spawn as nodeSpawn} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const execFile = promisify(nodeExecFile);
const DAEMON_URL = 'http://127.0.0.1:9090';

export interface DevChild {
  readonly pid?: number;

  on(event: 'exit' | 'error', listener: (value?: number | Error | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface DevDeps {
  readonly packExamples?: () => Promise<void>;
  readonly ensureDir?: (dir: string) => void;
  readonly spawn?: (
    command: string,
    args: string[],
    options: {cwd: string; detached?: boolean; env: NodeJS.ProcessEnv},
  ) => DevChild;
  readonly killProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => void;
  readonly waitForDaemon?: (baseUrl: string, signal: AbortSignal) => Promise<void>;
  readonly onShutdownSignal?: (handler: () => void) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly repoRoot?: string;
}

export interface ReadinessDeps {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function timeoutError(baseUrl: string): Error {
  return new Error(`mndw dev: timed out waiting for mndwd at ${baseUrl}`);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('mndw dev: daemon readiness aborted');
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    const state: {timer?: ReturnType<typeof setTimeout>} = {};

    const onAbort = (): void => {
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
      }

      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolveDelay();
    };

    state.timer = setTimeout(cleanup, ms);

    if (signal.aborted) {
      onAbort();

      return;
    }

    signal.addEventListener('abort', onAbort, {once: true});
  });
}

/** Polls the management list with a deadline that also aborts an in-flight request. */
export async function waitForDaemon(
  baseUrl: string,
  signal: AbortSignal,
  deps: ReadinessDeps = {},
): Promise<void> {
  if (signal.aborted) {
    throw abortError(signal);
  }

  const timeoutMs = deps.timeoutMs ?? 30_000;
  const fetchDaemon = deps.fetch ?? fetch;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      throw timeoutError(baseUrl);
    }

    const request = new AbortController();
    const timer = setTimeout(() => request.abort(), remaining);
    const abortRequest = (): void => request.abort(signal.reason);

    signal.addEventListener('abort', abortRequest, {once: true});

    try {
      const response = await fetchDaemon(`${baseUrl}/api/mgmt/list`, {signal: request.signal});

      if (response.ok) {
        await response.json();

        return;
      }
    } catch (_error) {
      if (signal.aborted) {
        throw abortError(signal);
      }

      if (request.signal.aborted) {
        throw timeoutError(baseUrl);
      }

      // Daemon is not ready yet.
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortRequest);
    }

    await delay(Math.min(250, deadline - Date.now()), signal);
  }
}

async function defaultPackExamples(repoRoot: string): Promise<void> {
  await execFile('pnpm', ['build-example-plugins', '--dev'], {cwd: repoRoot});
}

function defaultSpawn(
  command: string,
  args: string[],
  options: {cwd: string; detached?: boolean; env: NodeJS.ProcessEnv},
): DevChild {
  return nodeSpawn(command, args, {cwd: options.cwd, detached: options.detached, env: options.env, stdio: 'inherit'});
}

function defaultOnShutdownSignal(handler: () => void): void {
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

/** Starts packed examples, local mndwd, then Vite; exits either child with its sibling. */
export async function runDev(deps: DevDeps = {}): Promise<void> {
  const repoRoot = deps.repoRoot ?? resolve(import.meta.dirname, '..');
  const env = deps.env ?? process.env;
  const builtinDir = resolve(repoRoot, 'example-plugins', 'dist');
  const dataDir = resolve(repoRoot, '.dev-data');
  const userDir = resolve(dataDir, 'user-plugins');
  const packExamples = deps.packExamples ?? (() => defaultPackExamples(repoRoot));
  const ensureDir = deps.ensureDir ?? ((dir) => mkdirSync(dir, {recursive: true}));
  const spawn = deps.spawn ?? defaultSpawn;
  const killProcessGroup = deps.killProcessGroup ?? ((processGroupId, signal) => process.kill(processGroupId, signal));
  const waitForDaemonFn = deps.waitForDaemon ?? waitForDaemon;
  const onShutdownSignal = deps.onShutdownSignal ?? defaultOnShutdownSignal;

  await packExamples();
  ensureDir(dataDir);
  ensureDir(userDir);

  const children: DevChild[] = [];
  const processState: {daemon?: DevChild} = {};
  const readinessAbort = new AbortController();
  let resolveFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolveFinishedPromise) => {
    resolveFinished = resolveFinishedPromise;
  });
  let shuttingDown = false;
  let failure: Error | undefined;
  const shutdown = (stoppedChild?: DevChild, error?: Error): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    failure = error;
    readinessAbort.abort(error);

    for (const child of children) {
      if (child === stoppedChild) {
        continue;
      }

      try {
        if (child === processState.daemon && child.pid !== undefined) {
          killProcessGroup(-child.pid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // Child already exited.
      }
    }

    resolveFinished();
  };

  onShutdownSignal(shutdown);

  const daemonChild = spawn(
    'go',
    [
      'run',
      './cmd/mndwd',
      '--listen',
      '127.0.0.1:9090',
      '--dev',
      '--opkg',
      'stub',
      '--builtin-plugins-dir',
      builtinDir,
      '--data-dir',
      dataDir,
      '--user-plugins-dir',
      userDir,
    ],
    {cwd: resolve(repoRoot, 'packages', 'daemon'), detached: true, env},
  );

  processState.daemon = daemonChild;
  children.push(daemonChild);
  daemonChild.on('exit', (code) => {
    const exitCode = typeof code === 'number' ? code : null;
    const error = exitCode === 0 ? undefined : new Error(`mndw dev: daemon exited with code ${exitCode ?? 'unknown'}`);

    shutdown(daemonChild, error);
  });
  daemonChild.on('error', (error) => {
    shutdown(daemonChild, error instanceof Error ? error : new Error('mndw dev: daemon failed'));
  });

  try {
    await waitForDaemonFn(DAEMON_URL, readinessAbort.signal);
  } catch (error) {
    if (shuttingDown) {
      await finished;

      if (failure !== undefined) {
        throw failure;
      }

      return;
    }

    const readinessError = error instanceof Error ? error : new Error('mndw dev: daemon readiness failed');

    shutdown(undefined, readinessError);
    throw readinessError;
  }

  if (shuttingDown) {
    await finished;

    if (failure !== undefined) {
      throw failure;
    }

    return;
  }

  const host = spawn('pnpm', ['--filter', '@mndw/host', 'dev'], {
    cwd: repoRoot,
    env: {
      ...env,
      MNDW_DAEMON: DAEMON_URL,
      MNDW_BUILTIN_PLUGINS_DIR: builtinDir,
      MNDW_USER_PLUGINS_DIR: userDir,
    },
  });

  children.push(host);
  host.on('exit', (code) => {
    const exitCode = typeof code === 'number' ? code : null;
    const error = exitCode === 0 ? undefined : new Error(`mndw dev: host exited with code ${exitCode ?? 'unknown'}`);

    shutdown(host, error);
  });
  host.on('error', (error) => {
    shutdown(host, error instanceof Error ? error : new Error('mndw dev: host failed'));
  });

  await finished;

  if (failure !== undefined) {
    throw failure;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runDev().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
