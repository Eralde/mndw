import {describe, expect, it, vi} from 'vitest';

import {CliError} from './errors.js';
import {type DevDeps, buildDaemonArgs, buildHostEnv, resolveDaemonLaunch, runDev} from './dev.js';

/** A stub `readManifest` returning just the name runDev reads, typed to the full contract. */
function stubReadManifest(name: string): DevDeps['readManifest'] {
  return (() => ({manifest: {name}, path: '/p/manifest.json'})) as unknown as DevDeps['readManifest'];
}

describe('buildDaemonArgs', () => {
  it('builds a --dev --opkg stub daemon invocation over the temp roots', () => {
    expect(buildDaemonArgs({listen: '127.0.0.1:9090', builtinDir: '/b', dataDir: '/d', userDir: '/u'})).toEqual([
      '--listen',
      '127.0.0.1:9090',
      '--dev',
      '--opkg',
      'stub',
      '--builtin-plugins-dir',
      '/b',
      '--data-dir',
      '/d',
      '--user-plugins-dir',
      '/u',
    ]);
  });
});

describe('resolveDaemonLaunch', () => {
  it('runs the daemon from source with `go run` in a source checkout', () => {
    const launch = resolveDaemonLaunch(['--dev'], {}, {
      daemonPackageDir: '/repo/packages/daemon',
      binaryExists: () => false,
    });

    expect(launch).toEqual({command: 'go', args: ['run', './cmd/mndwd', '--dev'], cwd: '/repo/packages/daemon'});
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

describe('buildHostEnv', () => {
  it('sets the sandbox, daemon, and plugin-dir env vars, forwarding the device host', () => {
    const env = buildHostEnv({
      pluginSourceDir: '/p',
      daemonUrl: 'http://127.0.0.1:9090',
      builtinDir: '/b',
      userDir: '/u',
      hostDevice: 'http://192.168.1.1',
    }, {PATH: '/bin'});

    expect(env).toMatchObject({
      PATH: '/bin',
      MNDW_SANDBOX_PLUGIN: '/p',
      MNDW_DAEMON: 'http://127.0.0.1:9090',
      MNDW_BUILTIN_PLUGINS_DIR: '/b',
      MNDW_USER_PLUGINS_DIR: '/u',
      MNDW_HOST_DEVICE: 'http://192.168.1.1',
    });
  });

  it('omits the device host when not provided', () => {
    const env = buildHostEnv({
      pluginSourceDir: '/p',
      daemonUrl: 'http://127.0.0.1:9090',
      builtinDir: '/b',
      userDir: '/u',
    }, {});

    expect(env.MNDW_HOST_DEVICE).toBeUndefined();
  });
});

interface FakeChild {
  on(event: 'exit', listener: () => void): void;
  kill: ReturnType<typeof vi.fn>;
  emitExit(): void;
}

function fakeChild(): FakeChild {
  let exitListener: (() => void) | undefined;

  return {
    on: (_event: 'exit', listener: () => void) => {
      exitListener = listener;
    },
    kill: vi.fn(),
    emitExit: () => exitListener?.(),
  };
}

interface Harness {
  deps: DevDeps;
  spawn: ReturnType<typeof vi.fn>;
  waitForDaemon: ReturnType<typeof vi.fn>;
  children: FakeChild[];
  removeDir: ReturnType<typeof vi.fn>;
  symlinkDir: ReturnType<typeof vi.fn>;
  tempDirs: string[];
  getSignalHandler(): (() => void) | undefined;
}

function harness(overrides: Partial<DevDeps> = {}): Harness {
  const children: FakeChild[] = [];
  const tempDirs: string[] = [];
  let signalHandler: (() => void) | undefined;

  const spawn = vi.fn(() => {
    const child = fakeChild();

    children.push(child);

    return child;
  });
  const removeDir = vi.fn();
  const symlinkDir = vi.fn();
  const waitForDaemon = vi.fn(() => Promise.resolve());

  const deps: DevDeps = {
    readManifest: vi.fn(stubReadManifest('demo-page')),
    makeTempDir: vi.fn((prefix: string) => {
      const dir = `/tmp/${prefix}X`;

      tempDirs.push(dir);

      return dir;
    }),
    symlinkDir,
    removeDir,
    spawn,
    waitForDaemon,
    onShutdownSignal: (handler: () => void) => {
      signalHandler = handler;
    },
    findDaemonPackageDir: () => '/repo/packages/daemon',
    fileExists: () => true,
    env: {PATH: '/bin'},
    ...overrides,
  };

  return {
    deps,
    spawn,
    waitForDaemon,
    children,
    removeDir,
    symlinkDir,
    tempDirs,
    getSignalHandler: () => signalHandler,
  };
}

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

    await runDev('example-plugins/demo-page', {}, h.deps);

    expect(h.symlinkDir).toHaveBeenCalledWith(
      expect.stringContaining('demo-page'),
      expect.stringContaining('demo-page'),
    );
    expect(h.spawn).toHaveBeenNthCalledWith(
      1,
      'go',
      expect.arrayContaining(['run', './cmd/mndwd']),
      expect.objectContaining({cwd: '/repo/packages/daemon'}),
    );
    expect(h.waitForDaemon).toHaveBeenCalledWith('http://127.0.0.1:9090', 'demo-page');
    expect(h.spawn).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['--filter', '@mndw/host', 'dev'],
      expect.objectContaining({
        env: expect.objectContaining({
          MNDW_SANDBOX_PLUGIN: expect.stringContaining('demo-page'),
          MNDW_DAEMON: 'http://127.0.0.1:9090',
        }),
      }),
    );
  });

  it('fails with an actionable error and copies nothing when the symlink cannot be created', async () => {
    const h = harness({
      symlinkDir: vi.fn(() => {
        throw new Error('EPERM');
      }),
    });

    await expect(runDev('example-plugins/demo-page', {}, h.deps)).rejects.toThrow(CliError);
    expect(h.spawn).not.toHaveBeenCalled();
    // The temp dirs it created are cleaned up.
    expect(h.removeDir).toHaveBeenCalled();
  });

  it('terminates both children and removes only its temp dirs on a shutdown signal', async () => {
    const h = harness();

    await runDev('example-plugins/demo-page', {}, h.deps);

    const signalHandler = h.getSignalHandler();

    signalHandler?.();

    for (const child of h.children) {
      expect(child.kill).toHaveBeenCalled();
    }

    for (const dir of h.tempDirs) {
      expect(h.removeDir).toHaveBeenCalledWith(dir);
    }
  });

  it('terminates both children and cleans up when either child exits', async () => {
    const h = harness();

    await runDev('example-plugins/demo-page', {}, h.deps);
    h.removeDir.mockClear();

    // The daemon child exits.
    h.children[0].emitExit();

    expect(h.children[1].kill).toHaveBeenCalled();
    expect(h.removeDir).toHaveBeenCalled();
  });
});
