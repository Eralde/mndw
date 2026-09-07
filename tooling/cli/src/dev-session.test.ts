import {describe, expect, it, vi} from 'vitest';

import {
  type DevSessionChild,
  type DevSessionConfig,
  type DevSessionDeps,
  buildDevDaemonArgs,
  buildDevHostEnv,
  runDevSession,
  waitForDevDaemon,
} from './dev-session.js';

function closedWatcher(): {onChange: () => void; close: () => Promise<void>} {
  return {onChange: () => undefined, close: () => Promise.resolve()};
}

function config(overrides: Partial<DevSessionConfig> = {}): DevSessionConfig {
  return {
    repoRoot: '/repo',
    daemon: {command: 'go', args: ['run', './cmd/mndwd'], cwd: '/repo/daemon/mndwd'},
    listen: '127.0.0.1:9090',
    daemonUrl: 'http://127.0.0.1:9090',
    builtinDir: '/builtin',
    dataDir: '/data',
    userDir: '/user',
    env: {PATH: '/bin', MNDW_SANDBOX_PLUGIN: '/inherited'},
    hostDevice: 'http://device.test',
    isReady: () => true,
    createWatcher: () => closedWatcher(),
    ...overrides,
  };
}

function response(json: () => unknown, ok = true): Response {
  return {ok, json} as unknown as Response;
}

describe('development session configuration', () => {
  it('builds common daemon flags in stable order', () => {
    expect(buildDevDaemonArgs(config())).toEqual([
      '--listen',
      '127.0.0.1:9090',
      '--dev',
      '--opkg',
      'stub',
      '--builtin-plugins-dir',
      '/builtin',
      '--data-dir',
      '/data',
      '--user-plugins-dir',
      '/user',
      '--controller-url',
      'http://device.test',
    ]);
  });

  it('builds host environment without mutating or leaking sandbox state', () => {
    const sessionConfig = config();
    const originalEnv = {...sessionConfig.env};

    expect(buildDevHostEnv(sessionConfig, '/sentinel')).toMatchObject({
      PATH: '/bin',
      MNDW_DAEMON: 'http://127.0.0.1:9090',
      MNDW_BUILTIN_PLUGINS_DIR: '/builtin',
      MNDW_USER_PLUGINS_DIR: '/user',
      MNDW_HOST_DEVICE: 'http://device.test',
      MNDW_DEV_RELOAD_SENTINEL: '/sentinel',
    });
    expect(buildDevHostEnv(sessionConfig, '/sentinel').MNDW_SANDBOX_PLUGIN).toBeUndefined();
    expect(sessionConfig.env).toEqual(originalEnv);
  });

  it('sets sandbox source path when adapter supplies one', () => {
    expect(buildDevHostEnv(config({sandboxPlugin: '/plugin'}), '/sentinel').MNDW_SANDBOX_PLUGIN).toBe('/plugin');
  });
});

describe('waitForDevDaemon', () => {
  it('returns after the first ready response', async () => {
    const fetchDaemon = vi.fn<typeof fetch>(() => Promise.resolve(response(() => ({plugins: []}))));

    await waitForDevDaemon(
      {baseUrl: 'http://daemon.test', signal: new AbortController().signal, isReady: () => true},
      fetchDaemon,
    );

    expect(fetchDaemon).toHaveBeenCalledWith(
      'http://daemon.test/api/mgmt/list',
      expect.objectContaining({signal: expect.any(AbortSignal)}),
    );
  });

  it('retries until the readiness predicate accepts a named plugin', async () => {
    vi.useFakeTimers();

    const payloads = [{plugins: []}, {plugins: [{name: 'sample-page'}]}];
    const fetchDaemon = vi.fn<typeof fetch>(() => Promise.resolve(response(() => payloads.shift())));
    const waiting = waitForDevDaemon({
      baseUrl: 'http://daemon.test',
      signal: new AbortController().signal,
      isReady: (payload) => {
        return typeof payload === 'object'
          && payload !== null
          && 'plugins' in payload
          && Array.isArray(payload.plugins)
          && payload.plugins.some((plugin: unknown) => {
            return typeof plugin === 'object' && plugin !== null && 'name' in plugin && plugin.name === 'sample-page';
          });
      },
    }, fetchDaemon);

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    await waiting;

    expect(fetchDaemon).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('retries non-OK, malformed, and predicate-false responses', async () => {
    vi.useFakeTimers();

    const fetchDaemon = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(() => ({ok: false}), false))
      .mockResolvedValueOnce(response(() => {
        throw new SyntaxError('invalid JSON');
      }))
      .mockResolvedValueOnce(response(() => ({ready: false})))
      .mockResolvedValueOnce(response(() => ({ready: true})));
    const waiting = waitForDevDaemon({
      baseUrl: 'http://daemon.test',
      signal: new AbortController().signal,
      isReady: (payload) =>
        typeof payload === 'object' && payload !== null && 'ready' in payload && payload.ready === true,
    }, fetchDaemon);

    await vi.advanceTimersByTimeAsync(750);
    await waiting;

    expect(fetchDaemon).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('times out a pending fetch at the deadline', async () => {
    vi.useFakeTimers();

    const fetchDaemon = vi.fn<typeof fetch>((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'));
        }, {once: true});
      });
    });
    const waiting = waitForDevDaemon({
      baseUrl: 'http://daemon.test',
      signal: new AbortController().signal,
      isReady: () => true,
      timeoutMs: 10,
    }, fetchDaemon);
    const rejection = expect(waiting).rejects.toThrow('timed out waiting for mndwd');

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    vi.useRealTimers();
  });

  it('does not accept a body that resolves after its deadline', async () => {
    vi.useFakeTimers();

    let resolveBody: ((value: unknown) => void) | undefined;
    const fetchDaemon = vi.fn<typeof fetch>(() =>
      Promise.resolve(response(() =>
        new Promise((resolve) => {
          resolveBody = resolve;
        })
      ))
    );
    const waiting = waitForDevDaemon({
      baseUrl: 'http://daemon.test',
      signal: new AbortController().signal,
      isReady: () => true,
      timeoutMs: 10,
    }, fetchDaemon);
    const rejection = expect(waiting).rejects.toThrow('timed out waiting for mndwd');

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    resolveBody?.({ready: true});
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    vi.useRealTimers();
  });

  it('rejects without fetching when already aborted', async () => {
    const controller = new AbortController();
    const fetchDaemon = vi.fn<typeof fetch>();

    controller.abort(new Error('shutdown'));

    await expect(
      waitForDevDaemon({baseUrl: 'http://daemon.test', signal: controller.signal, isReady: () => true}, fetchDaemon),
    )
      .rejects.toThrow('shutdown');
    expect(fetchDaemon).not.toHaveBeenCalled();
  });

  it('aborts during a retry delay', async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    const fetchDaemon = vi.fn<typeof fetch>(() => Promise.resolve(response(() => ({ready: false}))));
    const waiting = waitForDevDaemon({
      baseUrl: 'http://daemon.test',
      signal: controller.signal,
      isReady: () => false,
    }, fetchDaemon);
    const rejection = expect(waiting).rejects.toThrow('shutdown');

    await Promise.resolve();
    controller.abort(new Error('shutdown'));
    await rejection;
    vi.useRealTimers();
  });
});

interface FakeChild extends DevSessionChild {
  readonly kill: ReturnType<typeof vi.fn>;
  emitExit(code?: number | null): void;
  emitError(error?: Error): void;
}

function fakeChild(pid: number): FakeChild {
  let exitListener: ((code: number | null) => void) | undefined;
  let errorListener: ((error: Error) => void) | undefined;

  return {
    pid,
    on: (event, listener) => {
      if (event === 'exit') {
        exitListener = listener as (code: number | null) => void;
      } else {
        errorListener = listener as (error: Error) => void;
      }
    },
    kill: vi.fn(),
    emitExit: (code = 0) => exitListener?.(code),
    emitError: (error = new Error('child failed')) => errorListener?.(error),
  };
}

interface SessionHarness {
  readonly deps: DevSessionDeps;
  readonly children: FakeChild[];
  readonly spawn: ReturnType<typeof vi.fn>;
  readonly sentinel: {path: string; touch: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn>};
  readonly watcher: {onChange: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>};
  readonly watcherFactory: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  getShutdown(): (() => void) | undefined;
}

function sessionHarness(overrides: Partial<DevSessionDeps> = {}): SessionHarness {
  const children: FakeChild[] = [];
  let shutdownHandler: (() => void) | undefined;
  const spawn = vi.fn((_command: string) => {
    const child = fakeChild(children.length + 100);

    children.push(child);

    return child;
  });
  const sentinel = {path: '/repo/.dev-data/session/sentinel', touch: vi.fn(), cleanup: vi.fn()};
  const watcher = {onChange: vi.fn(), close: vi.fn(() => Promise.resolve())};
  const watcherFactory = vi.fn(() => watcher);
  const unsubscribe = vi.fn();
  const subscribeShutdown = vi.fn((handler: () => void) => {
    shutdownHandler = handler;

    return unsubscribe;
  });
  const fetchDaemon = vi.fn<typeof fetch>(() => Promise.resolve(response(() => ({ready: true}))));

  return {
    deps: {
      spawn: spawn as unknown as DevSessionDeps['spawn'],
      subscribeShutdown,
      createReloadSentinel: () => sentinel,
      fetch: fetchDaemon,
      ...overrides,
    },
    children,
    spawn,
    sentinel,
    watcher,
    watcherFactory,
    unsubscribe,
    getShutdown: () => shutdownHandler,
  };
}

describe('runDevSession', () => {
  it('starts daemon, waits for readiness, starts host, and waits for shutdown', async () => {
    const h = sessionHarness();
    const session = runDevSession(config({createWatcher: h.watcherFactory}), h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    expect(h.spawn.mock.calls.map(([command]) => command as string)).toEqual(['go', 'pnpm']);
    expect(h.watcherFactory).toHaveBeenCalledWith({
      daemonUrl: 'http://127.0.0.1:9090',
      touchSentinel: expect.any(Function),
    });

    h.getShutdown()?.();
    await session;

    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.sentinel.cleanup).toHaveBeenCalledTimes(1);
    expect(h.watcher.close).toHaveBeenCalledTimes(1);
  });

  it('does not start host when shutdown aborts readiness', async () => {
    const h = sessionHarness({
      fetch: vi.fn<typeof fetch>((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'));
          }, {once: true});
        })
      ),
    });
    const session = runDevSession(config({createWatcher: h.watcherFactory}), h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.getShutdown()?.();
    await session;

    expect(h.spawn.mock.calls.map(([command]) => command as string)).toEqual(['go']);
    expect(h.watcherFactory).not.toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.sentinel.cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects child errors after stopping the sibling', async () => {
    const h = sessionHarness();
    const session = runDevSession(config({createWatcher: h.watcherFactory}), h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.children[1]?.emitError(new Error('host failed'));

    await expect(session).rejects.toThrow('host failed');
    expect(h.children[0]?.kill).not.toHaveBeenCalled();
    expect(h.children[0]?.pid).toBe(100);
  });

  it('rejects nonzero and null child exits', async () => {
    const h = sessionHarness();
    const session = runDevSession(config({createWatcher: h.watcherFactory}), h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.children[1]?.emitExit(7);

    await expect(session).rejects.toThrow('host exited with code 7');

    const second = sessionHarness();
    const secondSession = runDevSession(config({createWatcher: second.watcherFactory}), second.deps);

    await vi.waitFor(() => expect(second.children).toHaveLength(2));
    second.children[1]?.emitExit(null);

    await expect(secondSession).rejects.toThrow('host exited with code unknown');
  });

  it('rejects synchronous daemon and host spawn failures with cleanup', async () => {
    const daemonFailure = sessionHarness({spawn: vi.fn(() => {
      throw new Error('daemon spawn failed');
    })});

    await expect(runDevSession(config(), daemonFailure.deps)).rejects.toThrow('daemon spawn failed');
    expect(daemonFailure.sentinel.cleanup).toHaveBeenCalledTimes(1);

    const hostFailure = sessionHarness({spawn: vi.fn((command: string) => {
      if (command === 'pnpm') {
        throw new Error('host spawn failed');
      }

      return fakeChild(100);
    })});

    await expect(runDevSession(config(), hostFailure.deps)).rejects.toThrow('host spawn failed');
    expect(hostFailure.sentinel.cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects sentinel and signal subscription failures before spawning', async () => {
    const sentinelFailure = sessionHarness({createReloadSentinel: () => {
      throw new Error('sentinel failed');
    }});

    await expect(runDevSession(config(), sentinelFailure.deps)).rejects.toThrow('sentinel failed');
    expect(sentinelFailure.spawn).not.toHaveBeenCalled();

    const subscriptionFailure = sessionHarness({subscribeShutdown: () => {
      throw new Error('subscribe failed');
    }});

    await expect(runDevSession(config(), subscriptionFailure.deps)).rejects.toThrow('subscribe failed');
    expect(subscriptionFailure.spawn).not.toHaveBeenCalled();
    expect(subscriptionFailure.sentinel.cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects watcher construction failures after stopping children', async () => {
    const killProcessGroup = vi.fn();
    const h = sessionHarness({killProcessGroup});
    const session = runDevSession(
      config({createWatcher: () => {
        throw new Error('watcher failed');
      }}),
      h.deps,
    );

    await expect(session).rejects.toThrow('watcher failed');
    expect(killProcessGroup).toHaveBeenCalledWith(-100, 'SIGTERM');
    expect(h.children[1]?.kill).toHaveBeenCalledTimes(1);
    expect(h.sentinel.cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs every cleanup stage and preserves the first terminal cause', async () => {
    const h = sessionHarness();
    const closeError = new Error('watcher close failed');

    h.watcher.close.mockRejectedValue(closeError);
    h.sentinel.cleanup.mockImplementation(() => {
      throw new Error('sentinel cleanup failed');
    });

    const session = runDevSession(config({createWatcher: h.watcherFactory}), h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.children[1]?.emitError(new Error('host terminal failure'));

    await expect(session).rejects.toThrow('host terminal failure');
    expect(h.watcher.close).toHaveBeenCalledTimes(1);
    expect(h.sentinel.cleanup).toHaveBeenCalledTimes(1);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('closes a watcher before cleaning the sentinel', async () => {
    const h = sessionHarness();
    const events: string[] = [];

    h.watcher.close.mockImplementation(() => {
      events.push('watcher');
    });
    h.sentinel.cleanup.mockImplementation(() => {
      events.push('sentinel');
    });

    const session = runDevSession(config({createWatcher: h.watcherFactory}), h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.getShutdown()?.();
    await session;

    expect(events).toEqual(['watcher', 'sentinel']);
  });

  it('retains the first terminal failure when sibling termination exits reentrantly', async () => {
    const h = sessionHarness();
    const session = runDevSession(config({createWatcher: h.watcherFactory}), h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.children[0]?.kill.mockImplementation(() => h.children[1]?.emitExit(null));
    h.children[1]?.emitError(new Error('first failure'));

    await expect(session).rejects.toThrow('first failure');
  });

  it('uses process groups on POSIX and direct child termination on Windows', async () => {
    const posixKillGroup = vi.fn();
    const posix = sessionHarness({killProcessGroup: posixKillGroup});
    const posixSession = runDevSession(config({createWatcher: posix.watcherFactory}), posix.deps);

    await vi.waitFor(() => expect(posix.children).toHaveLength(2));
    posix.getShutdown()?.();
    await posixSession;

    expect(posixKillGroup).toHaveBeenCalledWith(-100, 'SIGTERM');
    expect(posix.children[0]?.kill).not.toHaveBeenCalled();
    expect(posix.children[1]?.kill).toHaveBeenCalledWith('SIGTERM');

    const windowsKillGroup = vi.fn();
    const windows = sessionHarness({platform: 'win32', killProcessGroup: windowsKillGroup});
    const windowsSession = runDevSession(config({createWatcher: windows.watcherFactory}), windows.deps);

    await vi.waitFor(() => expect(windows.children).toHaveLength(2));
    windows.getShutdown()?.();
    await windowsSession;

    expect(windowsKillGroup).not.toHaveBeenCalled();
    expect(windows.children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(windows.children[1]?.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not leak a host when shutdown fires synchronously during host spawn', async () => {
    const h = sessionHarness();
    const spawn = vi.fn((command: string) => {
      const child = fakeChild(h.children.length + 100);

      h.children.push(child);

      if (command === 'pnpm') {
        h.getShutdown()?.();
      }

      return child;
    });
    const session = runDevSession(config({createWatcher: h.watcherFactory}), {...h.deps, spawn});

    expect(h.getShutdown()).toBeDefined();
    await session;

    expect(h.children).toHaveLength(2);
    expect(h.watcherFactory).not.toHaveBeenCalled();
    expect(h.children[1]?.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
