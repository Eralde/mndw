import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

import {describe, expect, it, vi} from 'vitest';

import {CliError} from './errors.js';
import {type DevSessionChild, type DevSessionDeps} from './dev-session.js';
import {type GoBuildSpawn} from './go-backend-build.js';
import {
  type BackendWatchOptions,
  type DevDeps,
  type DevOptions,
  type GoBuildResult,
  defaultBuildGoBackend,
  resolveDaemonLaunch,
  runDev,
  watchPluginBackend,
} from './dev.js';
import {type WatchBuildOptions, type WatchHandle} from './watch.js';

function deferred<T>(): {promise: Promise<T>; resolve(value: T): void} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolveDeferred) => {
    resolvePromise = resolveDeferred;
  });

  return {promise, resolve: resolvePromise};
}

/** A stub `readManifest` returning just the name runDev reads, typed to the full contract. */
function stubReadManifest(name: string): DevDeps['readManifest'] {
  return (() => ({manifest: {name}, path: '/p/manifest.json'})) as unknown as DevDeps['readManifest'];
}

describe('defaultBuildGoBackend', () => {
  it.each([
    ['dns-lookup-widget', 'dns-util'],
    ['ping-widget', 'ping-util'],
  ])('builds %s command using its discovered executable name', (pluginName, commandName) => {
    const runBuild = vi.fn<GoBuildSpawn>(() => ({status: 0, signal: null}));
    const sourceRoot = pluginName === 'ping-widget' ? 'plugins/examples' : 'plugins/builtin';
    const pluginDir = resolve(import.meta.dirname, '..', '..', '..', sourceRoot, pluginName);

    const result = defaultBuildGoBackend(pluginDir, runBuild);

    expect(result).toEqual({success: true, skipped: false});
    expect(runBuild).toHaveBeenCalledWith(
      'go',
      ['build', '-ldflags', '-s -w', '-o', resolve(pluginDir, 'backend', commandName), `./cmd/${commandName}`],
      expect.objectContaining({cwd: resolve(pluginDir, 'backend')}),
    );
    expect(runBuild.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({GOWORK: 'off', CGO_ENABLED: '0'}),
    }));
  });
});

describe('resolveDaemonLaunch', () => {
  it('runs the daemon from source with `go run` in a source checkout', () => {
    const launch = resolveDaemonLaunch(['--dev'], {}, {
      daemonPackageDir: '/repo/daemon/mndwd',
      binaryExists: () => false,
    });

    expect(launch).toEqual({command: 'go', args: ['run', './cmd/mndwd', '--dev'], cwd: '/repo/daemon/mndwd'});
  });

  it('uses an explicit --daemon binary outside a source checkout', () => {
    const launch = resolveDaemonLaunch(['--dev'], {daemonBinary: '/usr/bin/mndwd'}, {
      daemonPackageDir: null,
      binaryExists: () => true,
    });

    expect(launch).toEqual({command: '/usr/bin/mndwd', args: ['--dev']});
  });

  it('rejects a missing --daemon binary before anything is launched', () => {
    expect(() =>
      resolveDaemonLaunch(['--dev'], {daemonBinary: '/nope'}, {daemonPackageDir: null, binaryExists: () => false})
    ).toThrow(CliError);
  });

  it('requires a source checkout or --daemon when neither is available', () => {
    expect(() => resolveDaemonLaunch(['--dev'], {}, {daemonPackageDir: null, binaryExists: () => false})).toThrow(
      /source checkout|--daemon/,
    );
  });
});

interface FakeChild extends DevSessionChild {
  readonly pid: number;
  kill: ReturnType<typeof vi.fn>;
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

interface Harness {
  deps: DevDeps;
  spawn: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  children: FakeChild[];
  removeDir: ReturnType<typeof vi.fn>;
  symlinkDir: ReturnType<typeof vi.fn>;
  tempDirs: string[];
  watcher: MockWatchHandle;
  sentinel: {path: string; touch: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn>};
  getSignalHandler(): (() => void) | undefined;
}

interface MockWatchHandle extends Omit<WatchHandle, 'close'> {
  close: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<DevDeps> = {}): Harness {
  const children: FakeChild[] = [];
  const tempDirs: string[] = [];
  let signalHandler: (() => void) | undefined;

  const spawn = vi.fn(() => {
    const child = fakeChild(children.length + 100);

    children.push(child);

    return child;
  });
  const removeDir = vi.fn();
  const symlinkDir = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve({
      ok: true,
      json: () => ({plugins: [{name: 'sample-page'}]}),
    } as unknown as Response)
  );
  const watcher: MockWatchHandle = {onChange: vi.fn(), close: vi.fn(() => Promise.resolve())};
  const sentinel = {path: '/repo/.dev-data/mndw-dev-reload/session-one/sentinel', touch: vi.fn(), cleanup: vi.fn()};
  const watchBackend = vi.fn(() => watcher);
  const session: DevSessionDeps = {
    spawn: spawn as unknown as DevSessionDeps['spawn'],
    fetch,
    subscribeShutdown: (handler: () => void) => {
      signalHandler = handler;

      return vi.fn();
    },
    createReloadSentinel: vi.fn(() => sentinel),
    ...overrides.session,
  };

  const deps: DevDeps = {
    readManifest: vi.fn(stubReadManifest('sample-page')),
    makeTempDir: vi.fn((prefix: string) => {
      const dir = `/tmp/${prefix}X`;

      tempDirs.push(dir);

      return dir;
    }),
    symlinkDir,
    removeDir,
    findDaemonPackageDir: () => '/repo/daemon/mndwd',
    fileExists: () => true,
    buildGoBackend: vi.fn(() => ({success: true, skipped: true})),
    watchBackend,
    env: {PATH: '/bin'},
    ...overrides,
    session,
  };

  return {
    deps,
    spawn,
    fetch,
    children,
    removeDir,
    symlinkDir,
    tempDirs,
    watcher,
    sentinel,
    getSignalHandler: () => signalHandler,
  };
}

async function startDev(
  h: Harness,
  pluginDir = 'plugins/examples/sample-page',
  options: DevOptions = {},
): Promise<{dev: Promise<void>}> {
  const dev = runDev(pluginDir, options, h.deps);

  await vi.waitFor(() => expect(h.children).toHaveLength(2));

  return {dev};
}

function backendManifest(name: string, kind: 'exec' | 'service'): BackendWatchOptions['manifest'] {
  const backend = kind === 'service'
    ? {
      kind,
      protocolVersion: 1,
      command: 'backend/service',
      routes: [{id: 'status', transport: 'http', method: 'GET', path: 'status'}],
    }
    : {
      kind,
      routes: [{
        id: 'status',
        transport: 'http',
        method: 'GET',
        path: 'status',
        command: 'backend/status.sh',
      }],
    };

  return {name, backend} as unknown as BackendWatchOptions['manifest'];
}

function successfulBuild(): GoBuildResult {
  return {success: true, skipped: false};
}

describe('watchPluginBackend', () => {
  it('passes backend source globs and exact output ignores to the watcher', () => {
    const pluginSourceDir = mkdtempSync(join(tmpdir(), 'mndw-watch-plugin-'));
    const commandDir = join(pluginSourceDir, 'backend', 'cmd', 'service');
    const watch = {onChange: vi.fn(), close: vi.fn(() => Promise.resolve())} satisfies WatchHandle;
    let watchOptions: WatchBuildOptions<GoBuildResult> | undefined;

    mkdirSync(commandDir, {recursive: true});

    try {
      watchPluginBackend({
        manifest: backendManifest('sample-page', 'service'),
        pluginSourceDir,
        pluginName: 'sample-page',
        daemonUrl: 'http://127.0.0.1:9090',
      }, {
        watchBackend: (options: WatchBuildOptions<GoBuildResult>) => {
          watchOptions = options;

          return watch;
        },
        buildBackend: vi.fn(() => successfulBuild()),
        touchSentinel: vi.fn(),
        restartService: vi.fn(() => Promise.resolve(true)),
      });

      expect(watchOptions?.paths).toEqual(expect.arrayContaining([
        join(pluginSourceDir, 'backend/**/*.go'),
        join(pluginSourceDir, 'backend/service'),
      ]));
      expect(watchOptions?.paths).not.toContain(join(pluginSourceDir, 'backend'));
      expect(watchOptions?.ignore).toEqual(expect.arrayContaining([
        join(pluginSourceDir, 'backend', 'service'),
        join(pluginSourceDir, 'backend', 'go.sum'),
      ]));
    } finally {
      rmSync(pluginSourceDir, {recursive: true, force: true});
    }
  });

  it('writes sentinel only after a service restart returns 200', async () => {
    const watch = {onChange: vi.fn(), close: vi.fn(() => Promise.resolve())} satisfies WatchHandle;
    const restart = deferred<boolean>();
    const touchSentinel = vi.fn();
    let watchOptions: WatchBuildOptions<GoBuildResult> | undefined;

    watchPluginBackend({
      manifest: backendManifest('sample-page', 'service'),
      pluginSourceDir: '/plugin',
      pluginName: 'sample-page',
      daemonUrl: 'http://127.0.0.1:9090',
    }, {
      watchBackend: (options: WatchBuildOptions<GoBuildResult>) => {
        watchOptions = options;

        return watch;
      },
      buildBackend: vi.fn(() => successfulBuild()),
      restartService: vi.fn(() => restart.promise),
      touchSentinel,
    });

    const result = watchOptions?.onResult;

    expect(result).toBeDefined();

    const pending = result?.({ok: true, value: successfulBuild(), changed: [], generation: 1}, {
      generation: 1,
      isCurrent: () => true,
    });

    await Promise.resolve();
    expect(touchSentinel).not.toHaveBeenCalled();

    restart.resolve(true);
    await pending;
    expect(touchSentinel).toHaveBeenCalledTimes(1);
  });

  it('suppresses sentinel and releases the watch loop when service restart fails', async () => {
    const watch = {onChange: vi.fn(), close: vi.fn(() => Promise.resolve())} satisfies WatchHandle;
    const buildBackend = vi.fn(() => successfulBuild());
    const restartService = vi.fn(() => Promise.resolve(false));
    const touchSentinel = vi.fn();
    let watchOptions: WatchBuildOptions<GoBuildResult> | undefined;

    watchPluginBackend({
      manifest: backendManifest('sample-page', 'service'),
      pluginSourceDir: '/plugin',
      pluginName: 'sample-page',
      daemonUrl: 'http://127.0.0.1:9090',
    }, {
      watchBackend: (options: WatchBuildOptions<GoBuildResult>) => {
        watchOptions = options;

        return watch;
      },
      buildBackend,
      restartService,
      touchSentinel,
    });

    await watchOptions?.onResult({ok: true, value: successfulBuild(), changed: [], generation: 1}, {
      generation: 1,
      isCurrent: () => true,
    });

    expect(restartService).toHaveBeenCalledTimes(1);
    expect(touchSentinel).not.toHaveBeenCalled();
    await watchOptions?.build(['/plugin/backend/main.go']);
    expect(buildBackend).toHaveBeenCalledTimes(1);
  });

  it('does not restart exec backends and writes sentinel after a successful build', async () => {
    const watch = {onChange: vi.fn(), close: vi.fn(() => Promise.resolve())} satisfies WatchHandle;
    const restartService = vi.fn(() => Promise.resolve(true));
    const touchSentinel = vi.fn();
    let watchOptions: WatchBuildOptions<GoBuildResult> | undefined;

    watchPluginBackend({
      manifest: backendManifest('sample-page', 'exec'),
      pluginSourceDir: '/plugin',
      pluginName: 'sample-page',
      daemonUrl: 'http://127.0.0.1:9090',
    }, {
      watchBackend: (options: WatchBuildOptions<GoBuildResult>) => {
        watchOptions = options;

        return watch;
      },
      buildBackend: vi.fn(() => successfulBuild()),
      restartService,
      touchSentinel,
    });

    await watchOptions?.onResult({ok: true, value: successfulBuild(), changed: [], generation: 1}, {
      generation: 1,
      isCurrent: () => true,
    });

    expect(restartService).not.toHaveBeenCalled();
    expect(touchSentinel).toHaveBeenCalledTimes(1);
  });

  it('does not restart or signal after a build failure', async () => {
    const watch = {onChange: vi.fn(), close: vi.fn(() => Promise.resolve())} satisfies WatchHandle;
    const restartService = vi.fn(() => Promise.resolve(true));
    const touchSentinel = vi.fn();
    let watchOptions: WatchBuildOptions<GoBuildResult> | undefined;

    watchPluginBackend({
      manifest: backendManifest('sample-page', 'service'),
      pluginSourceDir: '/plugin',
      pluginName: 'sample-page',
      daemonUrl: 'http://127.0.0.1:9090',
    }, {
      watchBackend: (options: WatchBuildOptions<GoBuildResult>) => {
        watchOptions = options;

        return watch;
      },
      buildBackend: vi.fn(() => successfulBuild()),
      restartService,
      touchSentinel,
    });

    await watchOptions?.onResult({ok: false, error: new Error('broken edit'), changed: [], generation: 1}, {
      generation: 1,
      isCurrent: () => true,
    });

    expect(restartService).not.toHaveBeenCalled();
    expect(touchSentinel).not.toHaveBeenCalled();
  });
});

describe('runDev', () => {
  it('validates the plugin before launching any child process', async () => {
    const h = harness({
      readManifest: (() => {
        throw new CliError('bad manifest');
      }) as unknown as DevDeps['readManifest'],
    });

    await expect(runDev('bad', {}, h.deps)).rejects.toThrow('bad manifest');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('spawns the daemon, waits for readiness, then spawns the host with sandbox env', async () => {
    const h = harness();

    const {dev} = await startDev(h);

    expect(h.symlinkDir).toHaveBeenCalledWith(
      expect.stringContaining('sample-page'),
      expect.stringContaining('sample-page'),
    );
    expect(h.spawn).toHaveBeenNthCalledWith(
      1,
      'go',
      expect.arrayContaining(['run', './cmd/mndwd']),
      expect.objectContaining({
        cwd: '/repo/daemon/mndwd',
        env: expect.objectContaining({MNDW_PLUGIN_RUNTIME_ROOT: '/tmp/d-X/plugin-runtime'}),
      }),
    );
    expect(h.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/api/mgmt/list',
      expect.objectContaining({signal: expect.any(AbortSignal)}),
    );
    expect(h.spawn).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['--filter', '@mndw/host', 'dev'],
      expect.objectContaining({
        env: expect.objectContaining({
          MNDW_SANDBOX_PLUGIN: expect.stringContaining('sample-page'),
          MNDW_DAEMON: 'http://127.0.0.1:9090',
        }),
      }),
    );

    h.getSignalHandler()?.();
    await dev;
  });

  it('requires the named plugin before launching the host', async () => {
    const h = harness({
      session: {
        fetch: vi.fn<typeof fetch>(() =>
          Promise.resolve({
            ok: true,
            json: () => ({plugins: [{name: 'other-page'}]}),
          } as unknown as Response)
        ),
      },
    });
    const dev = runDev('plugins/examples/sample-page', {}, h.deps);

    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.getSignalHandler()?.();

    await dev;
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('uses explicit device option for both daemon and host', async () => {
    const h = harness({env: {PATH: '/bin', MNDW_HOST_DEVICE: 'http://env-device.test'}});
    const {dev} = await startDev(h, 'plugins/examples/sample-page', {hostDevice: 'http://option-device.test'});

    expect(h.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      '--controller-url',
      'http://option-device.test',
    ]));
    expect(h.spawn.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({MNDW_HOST_DEVICE: 'http://option-device.test'}),
    }));

    h.getSignalHandler()?.();
    await dev;
  });

  it('uses inherited device environment when option is absent', async () => {
    const h = harness({env: {PATH: '/bin', MNDW_HOST_DEVICE: 'http://env-device.test'}});
    const {dev} = await startDev(h);

    expect(h.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      '--controller-url',
      'http://env-device.test',
    ]));
    expect(h.spawn.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({MNDW_HOST_DEVICE: 'http://env-device.test'}),
    }));

    h.getSignalHandler()?.();
    await dev;
  });

  it('removes device environment when neither option nor environment supplies one', async () => {
    const h = harness({env: {PATH: '/bin'}});
    const {dev} = await startDev(h);

    expect(h.spawn.mock.calls[0]?.[1]).not.toContain('--controller-url');
    expect(h.spawn.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      env: expect.not.objectContaining({MNDW_HOST_DEVICE: expect.anything()}),
    }));

    h.getSignalHandler()?.();
    await dev;
  });

  it('passes custom port and repository root as host cwd', async () => {
    const h = harness({repoRoot: '/custom/repo'});
    const {dev} = await startDev(h, 'plugins/examples/sample-page', {port: 4321});

    expect(h.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--listen', '127.0.0.1:4321']));
    expect(h.spawn.mock.calls[1]?.[2]).toEqual(expect.objectContaining({cwd: '/custom/repo'}));

    h.getSignalHandler()?.();
    await dev;
  });

  it('discovers the repository daemon source checkout without injected dependencies', async () => {
    const h = harness({findDaemonPackageDir: undefined});

    const {dev} = await startDev(h);

    expect(h.spawn).toHaveBeenNthCalledWith(
      1,
      'go',
      expect.arrayContaining(['run', './cmd/mndwd']),
      expect.objectContaining({cwd: resolve(import.meta.dirname, '..', '..', '..', 'daemon', 'mndwd')}),
    );

    h.getSignalHandler()?.();
    await dev;
  });

  it('builds the Go backend before spawning the daemon', async () => {
    const buildGoBackend = vi.fn(() => ({success: true, skipped: false}));
    const h = harness({buildGoBackend});

    const {dev} = await startDev(h);

    expect(buildGoBackend).toHaveBeenCalledWith(expect.stringContaining('sample-page'));
    expect(h.spawn).toHaveBeenCalled();

    h.getSignalHandler()?.();
    await dev;
  });

  it('runs the shared Go helper before either dev child for a generated-style backend', async () => {
    const pluginDir = mkdtempSync(join(tmpdir(), 'mndw-generated-dev-'));
    const backendDir = join(pluginDir, 'backend');
    const commandDir = join(backendDir, 'cmd', 'generated-go-paged');
    const buildCalls: Array<{args: string[]; cwd: string; env: NodeJS.ProcessEnv}> = [];

    mkdirSync(commandDir, {recursive: true});
    writeFileSync(join(backendDir, 'go.mod'), 'module generated-go-page\ngo 1.26\n');
    writeFileSync(join(commandDir, 'main.go'), 'package main\nfunc main() {}\n');

    try {
      const spawnGo: GoBuildSpawn = (_command, args, options) => {
        buildCalls.push({args, cwd: options.cwd, env: options.env});

        return {status: 0, signal: null};
      };
      const buildBackend = vi.fn(() => defaultBuildGoBackend(pluginDir, spawnGo));
      const h = harness({
        readManifest: stubReadManifest('generated-go-page'),
        buildGoBackend: buildBackend,
        session: {
          fetch: vi.fn<typeof fetch>(() =>
            Promise.resolve({
              ok: true,
              json: () => ({plugins: [{name: 'generated-go-page'}]}),
            } as unknown as Response)
          ),
        },
      });

      const {dev} = await startDev(h, pluginDir);

      expect(buildCalls).toHaveLength(1);
      expect(buildCalls[0]?.args).toContain('-s -w');
      expect(buildCalls[0]?.env.GOWORK).toBe('off');
      expect(h.spawn).toHaveBeenCalled();

      h.getSignalHandler()?.();
      await dev;
    } finally {
      rmSync(pluginDir, {recursive: true, force: true});
    }
  });

  it('proceeds when Go backend build is skipped (no go.mod)', async () => {
    const buildGoBackend = vi.fn(() => ({success: true, skipped: true}));
    const h = harness({buildGoBackend});

    const {dev} = await startDev(h);

    expect(buildGoBackend).toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalled();

    h.getSignalHandler()?.();
    await dev;
  });

  it('fails with an actionable error and cleans up when Go backend build fails', async () => {
    const buildGoBackend = vi.fn(() => ({success: false, skipped: false, error: 'go build failed'}));
    const h = harness({buildGoBackend});

    await expect(runDev('plugins/examples/sample-page', {}, h.deps)).rejects.toThrow(/Go backend build failed/);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.removeDir).toHaveBeenCalled();
  });

  it('cleans only temporary directories successfully created before preparation fails', async () => {
    const makeTempDir = vi.fn((prefix: string) => {
      if (prefix === 'd-') {
        throw new Error('temp dir failed');
      }

      return '/tmp/first';
    });
    const h = harness({makeTempDir});

    await expect(runDev('plugins/examples/sample-page', {}, h.deps)).rejects.toThrow('temp dir failed');

    expect(h.removeDir.mock.calls).toEqual([['/tmp/first']]);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('cleans temporary directories when backend preparation throws', async () => {
    const h = harness({
      buildGoBackend: vi.fn(() => {
        throw new Error('backend builder failed');
      }),
    });

    await expect(runDev('plugins/examples/sample-page', {}, h.deps)).rejects.toThrow('backend builder failed');

    expect(h.removeDir).toHaveBeenCalledTimes(3);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('cleans temporary directories when daemon resolution fails', async () => {
    const h = harness({findDaemonPackageDir: () => null});

    await expect(runDev('plugins/examples/sample-page', {}, h.deps)).rejects.toThrow(/source checkout/);

    expect(h.removeDir).toHaveBeenCalledTimes(3);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('cleans temporary directories when shared session rejects', async () => {
    const h = harness({
      session: {
        spawn: vi.fn(() => {
          throw new Error('session spawn failed');
        }),
      },
    });

    await expect(runDev('plugins/examples/sample-page', {}, h.deps)).rejects.toThrow('session spawn failed');

    expect(h.removeDir).toHaveBeenCalledTimes(3);
  });

  it('fails with an actionable error and copies nothing when the symlink cannot be created', async () => {
    const h = harness({
      symlinkDir: vi.fn(() => {
        throw new Error('EPERM');
      }),
    });

    await expect(runDev('plugins/examples/sample-page', {}, h.deps)).rejects.toThrow(CliError);
    expect(h.spawn).not.toHaveBeenCalled();
    // The temp dirs it created are cleaned up.
    expect(h.removeDir).toHaveBeenCalled();
  });

  it('terminates both children and removes only its temp dirs on a shutdown signal', async () => {
    const h = harness();

    const {dev} = await startDev(h);

    const signalHandler = h.getSignalHandler();

    signalHandler?.();

    expect(h.children[1]?.kill).toHaveBeenCalledWith('SIGTERM');

    await dev;

    for (const dir of h.tempDirs) {
      expect(h.removeDir).toHaveBeenCalledWith(dir);
    }
  });

  it('terminates both children and cleans up when either child exits', async () => {
    const h = harness();

    const {dev} = await startDev(h);

    h.removeDir.mockClear();

    // The daemon child exits.
    h.children[0].emitExit();

    expect(h.children[1].kill).toHaveBeenCalled();
    await dev;
    expect(h.removeDir).toHaveBeenCalled();
  });

  it('waits for watcher close before sentinel and temp cleanup', async () => {
    const h = harness({readManifest: (() => ({
      manifest: backendManifest('sample-page', 'service'),
      path: '/repo/manifest.json',
    })) as unknown as DevDeps['readManifest']});
    const close = deferred<void>();

    h.watcher.close.mockReturnValue(close.promise);

    const {dev} = await startDev(h);

    h.removeDir.mockClear();

    h.getSignalHandler()?.();

    expect(h.sentinel.cleanup).not.toHaveBeenCalled();
    expect(h.removeDir).not.toHaveBeenCalled();

    close.resolve();
    await dev;

    expect(h.sentinel.cleanup).toHaveBeenCalledTimes(1);
    expect(h.removeDir).toHaveBeenCalled();
  });

  it('closes watcher and sentinel during shutdown', async () => {
    const h = harness({readManifest: (() => ({
      manifest: backendManifest('sample-page', 'service'),
      path: '/repo/manifest.json',
    })) as unknown as DevDeps['readManifest']});
    const {dev} = await startDev(h);

    h.getSignalHandler()?.();
    await dev;

    expect(h.watcher.close.mock.calls).toHaveLength(1);
    expect(h.sentinel.cleanup).toHaveBeenCalledTimes(1);
  });
});
