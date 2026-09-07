import {join} from 'node:path';

import crossSpawn from 'cross-spawn';

import {type ReloadSentinel, createReloadSentinel} from './dev-reload.js';
import {type WatchHandle} from './watch.js';

export interface DevSessionConfig {
  readonly repoRoot: string;
  readonly daemon: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
  };
  readonly listen: string;
  readonly daemonUrl: string;
  readonly builtinDir: string;
  readonly dataDir: string;
  readonly userDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly hostDevice?: string;
  readonly sandboxPlugin?: string;
  readonly isReady: (payload: unknown) => boolean;
  readonly createWatcher: (context: {
    readonly daemonUrl: string;
    readonly touchSentinel: () => void;
  }) => WatchHandle;
}

export interface DevSessionChild {
  readonly pid?: number;
  on(event: 'exit', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface DevSessionDeps {
  readonly spawn?: (
    command: string,
    args: string[],
    options: {cwd?: string; detached?: boolean; env: NodeJS.ProcessEnv},
  ) => DevSessionChild;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly subscribeShutdown?: (handler: () => void) => () => void;
  readonly createReloadSentinel?: (repoRoot: string) => ReloadSentinel;
  readonly fetch?: typeof fetch;
  readonly platform?: NodeJS.Platform;
}

export interface DevReadinessOptions {
  readonly baseUrl: string;
  readonly signal: AbortSignal;
  readonly isReady: (payload: unknown) => boolean;
  readonly timeoutMs?: number;
}

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return new Error(String(error));
  }

  return new Error(fallback);
}

function timeoutError(baseUrl: string): Error {
  return new Error(`mndw dev: timed out waiting for mndwd at ${baseUrl}`);
}

function abortError(signal: AbortSignal): Error {
  return asError(signal.reason, 'mndw dev: daemon readiness aborted');
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    const state: {timer?: ReturnType<typeof setTimeout>} = {};

    const onAbort = (): void => {
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
      }

      signal.removeEventListener('abort', onAbort);
      rejectDelay(abortError(signal));
    };
    const onTimer = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolveDelay();
    };

    if (signal.aborted) {
      rejectDelay(abortError(signal));

      return;
    }

    state.timer = setTimeout(onTimer, ms);
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

export function buildDevDaemonArgs(config: DevSessionConfig): string[] {
  const args = [
    '--listen',
    config.listen,
    '--dev',
    '--opkg',
    'stub',
    '--builtin-plugins-dir',
    config.builtinDir,
    '--data-dir',
    config.dataDir,
    '--user-plugins-dir',
    config.userDir,
  ];

  if (config.hostDevice !== undefined) {
    args.push('--controller-url', config.hostDevice);
  }

  return args;
}

export function buildDevHostEnv(config: DevSessionConfig, sentinelPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...config.env,
    MNDW_DAEMON: config.daemonUrl,
    MNDW_BUILTIN_PLUGINS_DIR: config.builtinDir,
    MNDW_USER_PLUGINS_DIR: config.userDir,
    MNDW_DEV_RELOAD_SENTINEL: sentinelPath,
  };

  if (config.sandboxPlugin === undefined) {
    delete env.MNDW_SANDBOX_PLUGIN;
  } else {
    env.MNDW_SANDBOX_PLUGIN = config.sandboxPlugin;
  }

  if (config.hostDevice === undefined) {
    delete env.MNDW_HOST_DEVICE;
  } else {
    env.MNDW_HOST_DEVICE = config.hostDevice;
  }

  return env;
}

export async function waitForDevDaemon(
  options: DevReadinessOptions,
  fetchDaemon: typeof fetch = fetch,
): Promise<void> {
  if (options.signal.aborted) {
    throw abortError(options.signal);
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      throw timeoutError(options.baseUrl);
    }

    const request = new AbortController();
    const timer = setTimeout(() => request.abort(), remaining);
    const abortRequest = (): void => request.abort(options.signal.reason);

    options.signal.addEventListener('abort', abortRequest, {once: true});

    try {
      const response = await fetchDaemon(`${options.baseUrl}/api/mgmt/list`, {signal: request.signal});

      if (response.ok) {
        const payload: unknown = await response.json();

        if (
          !options.signal.aborted
          && !request.signal.aborted
          && Date.now() < deadline
          && options.isReady(payload)
        ) {
          return;
        }
      }
    } catch (_error) {
      if (options.signal.aborted) {
        throw abortError(options.signal);
      }

      if (request.signal.aborted) {
        throw timeoutError(options.baseUrl);
      }

      // The daemon is not ready yet; continue polling until the deadline.
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abortRequest);
    }

    if (options.signal.aborted) {
      throw abortError(options.signal);
    }

    const remainingAfterResponse = deadline - Date.now();

    if (remainingAfterResponse <= 0) {
      throw timeoutError(options.baseUrl);
    }

    await delay(Math.min(250, remainingAfterResponse), options.signal);
  }
}

function defaultSpawn(
  command: string,
  args: string[],
  options: {cwd?: string; detached?: boolean; env: NodeJS.ProcessEnv},
): DevSessionChild {
  return crossSpawn(command, args, {
    cwd: options.cwd,
    detached: options.detached,
    env: options.env,
    stdio: 'inherit',
  });
}

function defaultSubscribeShutdown(handler: () => void): () => void {
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);

  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

function defaultKillProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  process.kill(processGroupId, signal);
}

interface ChildRecord {
  readonly child: DevSessionChild;
  readonly role: 'daemon' | 'host';
}

export async function runDevSession(config: DevSessionConfig, deps: DevSessionDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? defaultSpawn;
  const killProcessGroup = deps.killProcessGroup ?? defaultKillProcessGroup;
  const subscribeShutdown = deps.subscribeShutdown ?? defaultSubscribeShutdown;
  const makeReloadSentinel = deps.createReloadSentinel ?? createReloadSentinel;
  const fetchDaemon = deps.fetch ?? fetch;
  const children: ChildRecord[] = [];
  const readinessAbort = new AbortController();
  let reloadSentinel: ReloadSentinel | undefined;
  let watcher: WatchHandle | undefined;
  let unsubscribeShutdown: (() => void) | undefined;
  let terminal = false;
  let terminalCause: Error | undefined;
  let terminalChild: DevSessionChild | undefined;
  let resolveFinished: () => void = () => undefined;
  let rejectFinished: (error: unknown) => void = () => undefined;
  const finished = new Promise<void>((resolveFinishedPromise, rejectFinishedPromise) => {
    resolveFinished = resolveFinishedPromise;
    rejectFinished = rejectFinishedPromise;
  });

  const terminate = (record: ChildRecord): void => {
    try {
      if (record.role === 'daemon' && platform !== 'win32' && record.child.pid !== undefined) {
        killProcessGroup(-record.child.pid, 'SIGTERM');
      } else {
        record.child.kill('SIGTERM');
      }
    } catch {
      // A child or process group may have vanished before teardown reached it.
    }
  };

  const cleanupResources = async (): Promise<void> => {
    let cleanupFailure: Error | undefined;

    const recordCleanupFailure = (error: unknown, fallback: string): void => {
      if (cleanupFailure === undefined) {
        cleanupFailure = asError(error, fallback);
      }
    };

    try {
      await watcher?.close();
    } catch (error) {
      recordCleanupFailure(error, 'mndw dev: failed to close watcher');
    }

    try {
      reloadSentinel?.cleanup();
    } catch (error) {
      recordCleanupFailure(error, 'mndw dev: failed to clean reload sentinel');
    }

    try {
      unsubscribeShutdown?.();
    } catch (error) {
      recordCleanupFailure(error, 'mndw dev: failed to unsubscribe shutdown handlers');
    }

    if (terminalCause !== undefined) {
      throw terminalCause;
    }

    if (cleanupFailure !== undefined) {
      throw cleanupFailure;
    }
  };

  const beginShutdown = (stoppedChild?: DevSessionChild, cause?: Error): void => {
    if (terminal) {
      return;
    }

    terminal = true;
    terminalCause = cause;
    terminalChild = stoppedChild;
    readinessAbort.abort(cause);

    for (const record of children) {
      if (record.child !== stoppedChild) {
        terminate(record);
      }
    }

    // Defer resource cleanup one microtask so synchronous fake callbacks that fire during
    // acquisition can finish recording the acquired resource before cleanup inspects it.
    const cleanupPromise = Promise.resolve().then(cleanupResources);

    cleanupPromise.then(resolveFinished, rejectFinished);
  };

  const attachChild = (record: ChildRecord): void => {
    record.child.on('exit', (code) => {
      const cause = code === 0
        ? undefined
        : new Error(`mndw dev: ${record.role} exited with code ${code ?? 'unknown'}`);

      beginShutdown(record.child, cause);
    });
    record.child.on('error', (error) => {
      beginShutdown(record.child, asError(error, `mndw dev: ${record.role} failed`));
    });
  };

  try {
    reloadSentinel = makeReloadSentinel(config.repoRoot);
    unsubscribeShutdown = subscribeShutdown(() => beginShutdown());

    if (terminal) {
      await finished;

      return;
    }

    const daemon: ChildRecord = {
      child: spawn(
        config.daemon.command,
        [...config.daemon.args, ...buildDevDaemonArgs(config)],
        {
          cwd: config.daemon.cwd,
          detached: platform !== 'win32',
          env: {...config.env, MNDW_PLUGIN_RUNTIME_ROOT: join(config.dataDir, 'plugin-runtime')},
        },
      ),
      role: 'daemon',
    };

    children.push(daemon);
    attachChild(daemon);

    if (terminal) {
      if (terminalChild !== daemon.child) {
        terminate(daemon);
      }

      await finished;

      return;
    }

    await waitForDevDaemon({
      baseUrl: config.daemonUrl,
      signal: readinessAbort.signal,
      isReady: config.isReady,
    }, fetchDaemon);

    if (terminal) {
      await finished;

      return;
    }

    const host: ChildRecord = {
      child: spawn('pnpm', ['--filter', '@mndw/host', 'dev'], {
        cwd: config.repoRoot,
        env: buildDevHostEnv(config, reloadSentinel.path),
      }),
      role: 'host',
    };

    children.push(host);
    attachChild(host);

    if (terminal) {
      if (terminalChild !== host.child) {
        terminate(host);
      }

      await finished;

      return;
    }

    watcher = config.createWatcher({
      daemonUrl: config.daemonUrl,
      touchSentinel: () => reloadSentinel?.touch(),
    });
  } catch (error) {
    if (!terminal) {
      beginShutdown(undefined, asError(error, 'mndw dev: session failed'));
    }
  }

  await finished;
}
