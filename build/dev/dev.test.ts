import {afterEach, describe, expect, it, vi} from 'vitest';

import {type DevSessionChild, type DevSessionDeps} from '../../tooling/cli/src/dev-session.js';
import {type DevDeps, runDev} from './dev.js';

interface FakeChild extends DevSessionChild {
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
}

function fakeChild(pid: number): FakeChild {
  return {
    pid,
    on: () => undefined,
    kill: vi.fn(),
  };
}

interface Harness {
  readonly deps: DevDeps;
  readonly packBuiltinPlugins: ReturnType<typeof vi.fn>;
  readonly ensureDir: ReturnType<typeof vi.fn>;
  readonly spawn: ReturnType<typeof vi.fn>;
  readonly killProcessGroup: ReturnType<typeof vi.fn>;
  readonly watcher: {close: ReturnType<typeof vi.fn>};
  getShutdown(): (() => void) | undefined;
}

function harness(overrides: Partial<DevDeps> = {}): Harness {
  const children: FakeChild[] = [];
  let shutdownHandler: (() => void) | undefined;
  const packBuiltinPlugins = vi.fn(() => Promise.resolve());
  const ensureDir = vi.fn();
  const spawn = vi.fn(() => {
    const child = fakeChild(children.length + 100);

    children.push(child);

    return child;
  });
  const killProcessGroup = vi.fn();
  const watcher = {onChange: vi.fn(), close: vi.fn(() => Promise.resolve())};
  const subscribeShutdown = vi.fn((handler: () => void) => {
    shutdownHandler = handler;

    return vi.fn();
  });
  const session: DevSessionDeps = {
    spawn: spawn as unknown as DevSessionDeps['spawn'],
    killProcessGroup,
    subscribeShutdown,
    createReloadSentinel: () => ({
      path: '/repo/.dev-data/mndw-dev-reload/session-one/sentinel',
      touch: vi.fn(),
      cleanup: vi.fn(),
    }),
    fetch: vi.fn<typeof fetch>(() => Promise.resolve({ok: true, json: () => ({})} as Response)),
    ...overrides.session,
  };

  const deps: DevDeps = {
    packBuiltinPlugins,
    ensureDir,
    repoRoot: '/repo',
    env: {MNDW_HOST_DEVICE: 'http://router.test', MNDW_SANDBOX_PLUGIN: '/stale-sandbox'},
    watchBackend: vi.fn(() => watcher),
    ...overrides,
    session,
  };

  return {deps, packBuiltinPlugins, ensureDir, spawn, killProcessGroup, watcher, getShutdown: () => shutdownHandler};
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('repository dev adapter', () => {
  it('packs before starting session and maps daemon and host configuration', async () => {
    const h = harness();
    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2));

    expect(h.packBuiltinPlugins).toHaveBeenCalledBefore(h.spawn);
    expect(h.ensureDir).toHaveBeenNthCalledWith(1, '/repo/.dev-data');
    expect(h.ensureDir).toHaveBeenNthCalledWith(2, '/repo/.dev-data/user-plugins');
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
          MNDW_SANDBOX_PLUGIN: '/stale-sandbox',
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

    const hostOptions = h.spawn.mock.calls[1]?.[2] as {env: NodeJS.ProcessEnv} | undefined;

    expect(hostOptions?.env.MNDW_SANDBOX_PLUGIN).toBeUndefined();
    h.getShutdown()?.();
    await dev;
  });

  it('constructs builtin watcher after host startup', async () => {
    const h = harness();
    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2));

    expect(h.deps.watchBackend).toHaveBeenCalledTimes(1);
    expect(h.deps.watchBackend).toHaveBeenCalledWith(expect.objectContaining({paths: [], ignore: []}));

    h.getShutdown()?.();
    await dev;
  });

  it('preserves persistent repository directories during shutdown', async () => {
    const h = harness();
    const dev = runDev(h.deps);

    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2));
    h.getShutdown()?.();
    await dev;

    expect(h.ensureDir).toHaveBeenCalledWith('/repo/.dev-data');
    expect(h.ensureDir).toHaveBeenCalledWith('/repo/.dev-data/user-plugins');
  });

  it('does not start session when builtin packing fails', async () => {
    const h = harness({packBuiltinPlugins: vi.fn(() => Promise.reject(new Error('pack failed')))});

    await expect(runDev(h.deps)).rejects.toThrow('pack failed');

    expect(h.ensureDir).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
