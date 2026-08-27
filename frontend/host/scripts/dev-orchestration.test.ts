import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  type BuiltinWatchDeps,
  type DevDeps,
  runDev,
  waitForDaemon,
  watchBuiltinPlugins,
} from '../../../build/dev/dev.js';
import {type WatchBuildOptions, type WatchHandle, watchAndBuild} from '../../../tooling/cli/src/watch.js';

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
  sentinel: {path: string; touch: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn>};
  watcher: WatchHandle;
  watchBackend: ReturnType<typeof vi.fn>;
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
  const sentinel = {path: '/repo/.dev-data/mndw-dev-reload/session-one/sentinel', touch: vi.fn(), cleanup: vi.fn()};
  const watcher: WatchHandle = {onChange: vi.fn(), close: vi.fn(async () => undefined)};
  const watchBackend = vi.fn(() => watcher);

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
      createReloadSentinel: () => sentinel,
      watchBackend: watchBackend as DevDeps['watchBackend'],
      ...overrides,
    },
    packBuiltinPlugins,
    ensureDir,
    spawn,
    waitForDaemon,
    killProcessGroup,
    children,
    sentinel,
    watcher,
    watchBackend,
    getSignalHandler: () => signalHandler,
  };
}

interface BuiltinFixture {
  root: string;
  sourceRoot: string;
  distRoot: string;
}

interface BuiltinWatcher {
  handle: WatchHandle;
  emit(changedPath: string): void;
  watchBackend: ReturnType<typeof vi.fn>;
}

function builtinFixture(names: readonly string[], serviceNames: readonly string[] = []): BuiltinFixture {
  const root = mkdtempSync(join(tmpdir(), 'mndw-builtin-watch-test-'));
  const sourceRoot = join(root, 'plugins', 'builtin');
  const distRoot = join(sourceRoot, 'dist');

  for (const name of names) {
    const pluginDir = join(sourceRoot, name);
    mkdirSync(join(pluginDir, 'src'), {recursive: true});
    mkdirSync(join(pluginDir, 'backend'), {recursive: true});
    writeFileSync(join(pluginDir, 'src', 'index.ts'), 'export {};');
    writeFileSync(join(pluginDir, 'backend', 'main.go'), 'package main');
    writeFileSync(join(pluginDir, 'package.json'), '{}');
    writeFileSync(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({
        manifestVersion: 3,
        name,
        displayName: name,
        version: '1.0.0',
        widgets: [],
        ...(serviceNames.includes(name)
          ? {backend: {kind: 'service', command: 'backend/service', routes: []}}
          : {}),
      }),
    );
  }

  return {root, sourceRoot, distRoot};
}

function builtinWatcher(
  fixture: BuiltinFixture,
  names: readonly string[],
  overrides: Partial<BuiltinWatchDeps> = {},
): BuiltinWatcher {
  let listener: ((changedPath: string) => void) | undefined;
  const handle: WatchHandle = {
    onChange: vi.fn((nextListener: (changedPath: string) => void) => {
      listener = nextListener;
    }),
    close: vi.fn(async () => undefined),
  };
  const watchBackendSpy = vi.fn((options: WatchBuildOptions<unknown>): WatchHandle =>
    watchAndBuild(options, {
      createWatcher: () => handle,
    })
  );
  const watchBackend = watchBackendSpy as unknown as BuiltinWatchDeps['watchBackend'];

  return {
    handle: watchBuiltinPlugins({
      sourceRoot: fixture.sourceRoot,
      distRoot: fixture.distRoot,
      pluginNames: names,
      daemonUrl: 'http://daemon.test',
    }, {readManifest: () => ({manifest: {}} as never), ...overrides, watchBackend}),
    emit: (changedPath) => listener?.(changedPath),
    watchBackend: watchBackendSpy,
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
          MNDW_DEV_RELOAD_SENTINEL: '/repo/.dev-data/mndw-dev-reload/session-one/sentinel',
        },
      },
    );

    h.getSignalHandler()?.();
    await dev;
  });

  it('exports the reload sentinel and starts the builtin watcher after host startup', async () => {
    const h = harness();
    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));

    expect(h.spawn.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({MNDW_DEV_RELOAD_SENTINEL: h.sentinel.path}),
    }));
    expect(h.watchBackend).toHaveBeenCalledTimes(1);

    h.getSignalHandler()?.();
    await dev;
  });

  it('waits for watcher close before cleaning the sentinel session', async () => {
    const h = harness();
    const close = deferred<void>();
    h.watcher.close = vi.fn(() => close.promise);
    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.getSignalHandler()?.();
    await Promise.resolve();

    expect(h.sentinel.cleanup).not.toHaveBeenCalled();
    close.resolve(undefined);
    await dev;

    expect(h.watcher.close).toHaveBeenCalledTimes(1);
    expect(h.sentinel.cleanup).toHaveBeenCalledTimes(1);
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

describe('builtin watch routing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes frontend-only changes to buildFrontend without buildBackend', async () => {
    vi.useFakeTimers();
    const fixture = builtinFixture(['sample']);
    const buildFrontend = vi.fn(async () => undefined);
    const buildBackend = vi.fn(async () => undefined);
    const touchSentinel = vi.fn();
    const watcher = builtinWatcher(fixture, ['sample'], {buildFrontend, buildBackend, touchSentinel});

    try {
      expect(watcher.watchBackend.mock.calls[0]?.[0].paths).not.toContain(
        join(fixture.sourceRoot, 'sample', 'backend'),
      );
      watcher.emit(join(fixture.sourceRoot, 'sample', 'src', 'index.ts'));
      await vi.advanceTimersByTimeAsync(151);
      await vi.waitFor(() => expect(buildFrontend).toHaveBeenCalledWith('sample'));

      expect(buildBackend).not.toHaveBeenCalled();
      expect(touchSentinel).toHaveBeenCalledTimes(1);
    } finally {
      await watcher.handle.close();
      rmSync(fixture.root, {recursive: true, force: true});
    }
  });

  it('routes backend-only changes to buildBackend without frontend repack', async () => {
    vi.useFakeTimers();
    const fixture = builtinFixture(['sample'], ['sample']);
    const buildFrontend = vi.fn(async () => undefined);
    const buildBackend = vi.fn(async () => undefined);
    const restartService = vi.fn(async () => true);
    const touchSentinel = vi.fn();
    const watcher = builtinWatcher(fixture, ['sample'], {
      buildFrontend,
      buildBackend,
      restartService,
      touchSentinel,
      readManifest: () => ({manifest: {backend: {kind: 'service', command: 'backend/service'}}} as never),
    });

    try {
      watcher.emit(join(fixture.sourceRoot, 'sample', 'backend', 'main.go'));
      await vi.advanceTimersByTimeAsync(151);
      await vi.waitFor(() => expect(restartService).toHaveBeenCalledTimes(1));

      expect(buildBackend).toHaveBeenCalledWith('sample');
      expect(buildFrontend).not.toHaveBeenCalled();
      expect(touchSentinel).toHaveBeenCalledTimes(1);
    } finally {
      await watcher.handle.close();
      rmSync(fixture.root, {recursive: true, force: true});
    }
  });

  it('uses buildOne once when one plugin has frontend and backend changes', async () => {
    vi.useFakeTimers();
    const fixture = builtinFixture(['sample']);
    const buildFrontend = vi.fn(async () => undefined);
    const buildBackend = vi.fn(async () => undefined);
    const buildOne = vi.fn(async () => undefined);
    const watcher = builtinWatcher(fixture, ['sample'], {buildFrontend, buildBackend, buildOne});

    try {
      watcher.emit(join(fixture.sourceRoot, 'sample', 'src', 'index.ts'));
      watcher.emit(join(fixture.sourceRoot, 'sample', 'backend', 'main.go'));
      await vi.advanceTimersByTimeAsync(151);
      await vi.waitFor(() => expect(buildOne).toHaveBeenCalledTimes(1));

      expect(buildFrontend).not.toHaveBeenCalled();
      expect(buildBackend).not.toHaveBeenCalled();
    } finally {
      await watcher.handle.close();
      rmSync(fixture.root, {recursive: true, force: true});
    }
  });

  it('fans out one batch across plugins and restarts each rebuilt service plugin once', async () => {
    vi.useFakeTimers();
    const fixture = builtinFixture(['frontend', 'service-a', 'service-b'], ['service-a', 'service-b']);
    const buildFrontend = vi.fn(async () => undefined);
    const buildBackend = vi.fn(async () => undefined);
    const restartRequests: Array<ReturnType<typeof deferred<boolean>>> = [];
    const restartService = vi.fn(() => {
      const request = deferred<boolean>();
      restartRequests.push(request);

      return request.promise;
    });
    const touchSentinel = vi.fn();
    const watcher = builtinWatcher(fixture, ['frontend', 'service-a', 'service-b'], {
      buildFrontend,
      buildBackend,
      restartService,
      touchSentinel,
      readManifest: (pluginDir) => ({
        manifest: pluginDir.endsWith('service-a') || pluginDir.endsWith('service-b')
          ? {backend: {kind: 'service', command: 'backend/service'}}
          : {},
      } as never),
    });

    try {
      watcher.emit(join(fixture.sourceRoot, 'frontend', 'src', 'index.ts'));
      watcher.emit(join(fixture.sourceRoot, 'service-a', 'backend', 'main.go'));
      watcher.emit(join(fixture.sourceRoot, 'service-b', 'backend', 'main.go'));
      await vi.advanceTimersByTimeAsync(151);
      await vi.waitFor(() => expect(restartService).toHaveBeenCalledTimes(2));

      expect(buildFrontend).toHaveBeenCalledWith('frontend');
      expect(buildBackend).toHaveBeenCalledTimes(2);
      expect(touchSentinel).not.toHaveBeenCalled();

      restartRequests.forEach((request) => request.resolve(true));
      await vi.waitFor(() => expect(touchSentinel).toHaveBeenCalledTimes(1));
    } finally {
      await watcher.handle.close();
      rmSync(fixture.root, {recursive: true, force: true});
    }
  });

  it('suppresses sentinel when any service restart fails or times out', async () => {
    vi.useFakeTimers();
    const fixture = builtinFixture(['service-a', 'service-b'], ['service-a', 'service-b']);
    const restartResults = [Promise.resolve(true), Promise.resolve(false)];
    const restartService = vi.fn(() => restartResults.shift() ?? Promise.resolve(false));
    const touchSentinel = vi.fn();
    const watcher = builtinWatcher(fixture, ['service-a', 'service-b'], {
      buildBackend: vi.fn(async () => undefined),
      restartService,
      touchSentinel,
      readManifest: () => ({manifest: {backend: {kind: 'service', command: 'backend/service'}}} as never),
    });

    try {
      watcher.emit(join(fixture.sourceRoot, 'service-a', 'backend', 'main.go'));
      watcher.emit(join(fixture.sourceRoot, 'service-b', 'backend', 'main.go'));
      await vi.advanceTimersByTimeAsync(151);
      await vi.waitFor(() => expect(restartService).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(touchSentinel).not.toHaveBeenCalled());
    } finally {
      await watcher.handle.close();
      rmSync(fixture.root, {recursive: true, force: true});
    }
  });
});

function deferred<T>(): {promise: Promise<T>; resolve(value: T): void} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {promise, resolve: resolvePromise};
}
