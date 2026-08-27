import {describe, expect, it, vi} from 'vitest';

import {type DevDeps, runDev, waitForDaemon} from '../../../build/dev/dev.js';

interface FakeChild {
  readonly pid: number;
  on(event: 'exit' | 'error', listener: (value?: number | Error | null) => void): void;
  kill: ReturnType<typeof vi.fn>;
  emitExit(code?: number): void;
  emitError(): void;
}

function fakeChild(pid: number): FakeChild {
  const listeners: Partial<Record<'exit' | 'error', (value?: number | Error | null) => void>> = {};

  return {
    pid,
    on: (event: 'exit' | 'error', listener: (value?: number | Error | null) => void) => {
      listeners[event] = listener;
    },
    kill: vi.fn(),
    emitExit: (code = 0) => listeners.exit?.(code),
    emitError: () => listeners.error?.(new Error('child failed')),
  };
}

interface Harness {
  deps: DevDeps;
  packBuiltinPlugins: ReturnType<typeof vi.fn>;
  ensureDir: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
  waitForDaemon: ReturnType<typeof vi.fn>;
  killProcessGroup: ReturnType<typeof vi.fn>;
  children: FakeChild[];
  getSignalHandler(): (() => void) | undefined;
}

function harness(overrides: Partial<DevDeps> = {}): Harness {
  const children: FakeChild[] = [];
  let signalHandler: (() => void) | undefined;
  const packBuiltinPlugins = vi.fn(() => Promise.resolve());
  const ensureDir = vi.fn();
  const spawn = vi.fn(() => {
    const child = fakeChild(children.length + 100);

    children.push(child);

    return child;
  });
  const waitForDaemon = vi.fn(() => Promise.resolve());
  const killProcessGroup = vi.fn();

  return {
    deps: {
      packBuiltinPlugins,
      ensureDir,
      spawn,
      waitForDaemon,
      killProcessGroup,
      onShutdownSignal: (handler) => {
        signalHandler = handler;
      },
      env: {MNDW_HOST_DEVICE: 'http://router.test'},
      repoRoot: '/repo',
      ...overrides,
    },
    packBuiltinPlugins,
    ensureDir,
    spawn,
    waitForDaemon,
    killProcessGroup,
    children,
    getSignalHandler: () => signalHandler,
  };
}

describe('repository dev orchestration', () => {
  it('packs built-in plugins, waits for the daemon management list, then starts the host', async () => {
    const h = harness();
    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));

    expect(h.packBuiltinPlugins).toHaveBeenCalledBefore(h.spawn);
    expect(h.ensureDir).toHaveBeenCalledWith('/repo/.dev-data');
    expect(h.ensureDir).toHaveBeenCalledWith('/repo/.dev-data/user-plugins');
    expect(h.spawn).toHaveBeenNthCalledWith(
      1,
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
        '/repo/plugins/builtin/dist',
        '--data-dir',
        '/repo/.dev-data',
        '--user-plugins-dir',
        '/repo/.dev-data/user-plugins',
        '--controller-url',
        'http://router.test',
      ],
      {
        cwd: '/repo/daemon/mndwd',
        detached: true,
        env: {
          MNDW_HOST_DEVICE: 'http://router.test',
          MNDW_PLUGIN_RUNTIME_ROOT: '/repo/.dev-data/plugin-runtime',
        },
      },
    );
    expect(h.waitForDaemon).toHaveBeenCalledWith('http://127.0.0.1:9090', expect.any(AbortSignal));
    expect(h.spawn).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['--filter', '@mndw/host', 'dev'],
      {
        cwd: '/repo',
        env: {
          MNDW_HOST_DEVICE: 'http://router.test',
          MNDW_DAEMON: 'http://127.0.0.1:9090',
          MNDW_BUILTIN_PLUGINS_DIR: '/repo/plugins/builtin/dist',
          MNDW_USER_PLUGINS_DIR: '/repo/.dev-data/user-plugins',
        },
      },
    );

    h.getSignalHandler()?.();
    await dev;
  });

  it('terminates the detached daemon process group on shutdown', async () => {
    const h = harness();
    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.getSignalHandler()?.();
    await dev;

    expect(h.killProcessGroup).toHaveBeenCalledWith(-100, 'SIGTERM');
    expect(h.children[0].kill).not.toHaveBeenCalled();
  });

  it('stops only the sibling when a child exits and ignores later shutdown signals', async () => {
    const h = harness();

    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.children[1].emitExit();

    expect(h.killProcessGroup).toHaveBeenCalledWith(-100, 'SIGTERM');
    expect(h.children[1].kill).not.toHaveBeenCalled();

    h.getSignalHandler()?.();

    expect(h.killProcessGroup).toHaveBeenCalledTimes(1);
    await dev;
  });

  it('does not start the host when daemon readiness fails', async () => {
    const h = harness({waitForDaemon: vi.fn(() => Promise.reject(new Error('not ready')))});

    await expect(runDev(h.deps)).rejects.toThrow('not ready');

    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.killProcessGroup).toHaveBeenCalledWith(-100, 'SIGTERM');
  });

  it('stops the sibling when a child emits an error without killing the failed child', async () => {
    const h = harness();

    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.children[1].emitError();

    expect(h.killProcessGroup).toHaveBeenCalledWith(-100, 'SIGTERM');
    expect(h.children[1].kill).not.toHaveBeenCalled();
    await expect(dev).rejects.toThrow('child failed');
  });

  it('does not start the host after the daemon exits during readiness', async () => {
    const h = harness({
      waitForDaemon: vi.fn((_baseUrl: string, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        })
      ),
    });
    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0].emitExit();
    await dev;

    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.children[0].kill).not.toHaveBeenCalled();
  });

  it('cancels readiness immediately when a shutdown signal arrives', async () => {
    const h = harness({
      waitForDaemon: vi.fn((_baseUrl: string, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        })
      ),
    });
    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.getSignalHandler()?.();
    await dev;

    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.killProcessGroup).toHaveBeenCalledWith(-100, 'SIGTERM');
  });

  it('returns a failure when a child exits nonzero', async () => {
    const h = harness();
    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.children[1].emitExit(7);

    await expect(dev).rejects.toThrow('host exited with code 7');
    expect(h.killProcessGroup).toHaveBeenCalledWith(-100, 'SIGTERM');
  });

  it('aborts a stalled readiness request at its deadline', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {once: true});
      })
    );

    await expect(waitForDaemon('http://127.0.0.1:9090', controller.signal, {fetch, timeoutMs: 10})).rejects.toThrow(
      'timed out waiting for mndwd',
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/api/mgmt/list',
      expect.objectContaining({signal: expect.any(AbortSignal)}),
    );
  });

  it('cancels a stalled readiness request immediately when shutdown aborts', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {once: true});
      })
    );
    const waiting = waitForDaemon('http://127.0.0.1:9090', controller.signal, {fetch});

    controller.abort(new Error('shutdown'));

    await expect(waiting).rejects.toThrow('shutdown');
  });

  it('rejects without fetching when readiness starts after shutdown', async () => {
    const controller = new AbortController();
    const fetch = vi.fn();

    controller.abort(new Error('shutdown'));

    await expect(waitForDaemon('http://127.0.0.1:9090', controller.signal, {fetch})).rejects.toThrow('shutdown');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects polling cancellation with an Error when abort reason is not an Error', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(() => Promise.reject(new Error('not ready')));
    const waiting = waitForDaemon('http://127.0.0.1:9090', controller.signal, {fetch});

    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort('shutdown');

    await expect(waiting).rejects.toBeInstanceOf(Error);
  });
});
