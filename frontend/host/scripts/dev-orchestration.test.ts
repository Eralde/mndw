import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {type BuiltinWatchDeps, type DevDeps, runDev, watchBuiltinPlugins} from '../../../build/dev/dev.js';
import {type DevSessionChild, type DevSessionDeps} from '../../../tooling/cli/src/dev-session.js';
import {type WatchBuildOptions, type WatchHandle, watchAndBuild} from '../../../tooling/cli/src/watch.js';

interface FakeChild extends DevSessionChild {
  readonly pid: number;
  kill: ReturnType<typeof vi.fn>;
  emitExit(code?: number): void;
  emitError(): void;
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
    emitError: () => errorListener?.(new Error('child failed')),
  };
}

interface Harness {
  deps: DevDeps;
  packBuiltinPlugins: ReturnType<typeof vi.fn>;
  ensureDir: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
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
  const killProcessGroup = vi.fn();
  const sentinel = {path: '/repo/.dev-data/mndw-dev-reload/session-one/sentinel', touch: vi.fn(), cleanup: vi.fn()};
  const watcher: WatchHandle = {onChange: vi.fn(), close: vi.fn(async () => undefined)};
  const watchBackend = vi.fn(() => watcher);
  const session: DevSessionDeps = {
    spawn: spawn as unknown as DevSessionDeps['spawn'],
    killProcessGroup,
    subscribeShutdown: (handler: () => void) => {
      signalHandler = handler;

      return vi.fn();
    },
    createReloadSentinel: () => sentinel,
    fetch: vi.fn<typeof fetch>(() => Promise.resolve({ok: true, json: async () => ({})} as Response)),
    ...overrides.session,
  };

  return {
    deps: {
      packBuiltinPlugins,
      ensureDir,
      env: {MNDW_HOST_DEVICE: 'http://router.test'},
      repoRoot: '/repo',
      watchBackend: watchBackend as DevDeps['watchBackend'],
      ...overrides,
      session,
    },
    packBuiltinPlugins,
    ensureDir,
    spawn,
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
