import {existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import crossSpawn from 'cross-spawn';
import {CliError} from './errors.js';
import {type ReloadSentinel, createReloadSentinel, restartService as defaultRestartService} from './dev-reload.js';
import {type GoBuildSpawn, buildGoBackend} from './go-backend-build.js';
import {type LoadedManifest, readManifest} from './manifest.js';
import {resolvePluginDir} from './paths.js';
import {type BuildOutcome, type WatchBuildOptions, type WatchHandle, watchAndBuild} from './watch.js';

export interface DevOptions {
  /** Path to a prebuilt `mndwd` binary; required outside a source checkout. */
  readonly daemonBinary?: string;
  /** Listen/serve port for the local daemon (default 9090). */
  readonly port?: number;
  /** Forwarded to the host as `MNDW_HOST_DEVICE` (the Keenetic device to proxy `/rci`,`/auth` to). */
  readonly hostDevice?: string;
}

/** Minimal child-process surface the supervisor needs, so tests can substitute fakes. */
export interface DevChild {
  on(event: 'exit', listener: () => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** Injectable boundaries so the supervisor is unit-testable without real processes or fs. */
export interface DevDeps {
  readManifest?: (pluginDir: string) => LoadedManifest;
  makeTempDir?: (prefix: string) => string;
  symlinkDir?: (target: string, linkPath: string) => void;
  removeDir?: (dir: string) => void;
  spawn?: (command: string, args: string[], options: {cwd?: string; env?: NodeJS.ProcessEnv}) => DevChild;
  waitForDaemon?: (baseUrl: string, pluginName: string) => Promise<void>;
  onShutdownSignal?: (handler: () => void) => void;
  findDaemonPackageDir?: () => string | null;
  fileExists?: (path: string) => boolean;
  buildGoBackend?: (pluginSourceDir: string) => GoBuildResult;
  repoRoot?: string;
  createReloadSentinel?: (repoRoot: string) => ReloadSentinel;
  watchBackend?: (options: WatchBuildOptions<GoBuildResult>) => WatchHandle;
  restartService?: typeof defaultRestartService;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Outcome of a Go backend build attempt. */
export interface GoBuildResult {
  readonly success: boolean;
  readonly skipped: boolean;
  readonly error?: string;
}

interface DaemonDirs {
  readonly listen: string;
  readonly builtinDir: string;
  readonly dataDir: string;
  readonly userDir: string;
}

export interface DaemonLaunch {
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
}

interface HostEnvParams {
  readonly pluginSourceDir: string;
  readonly daemonUrl: string;
  readonly builtinDir: string;
  readonly userDir: string;
  readonly hostDevice?: string;
  readonly reloadSentinel?: string;
}

/** The daemon argv for a `mndw dev` session: dev auth bypass, opkg stub, over the temp roots. */
export function buildDaemonArgs(dirs: DaemonDirs, controllerURL?: string): string[] {
  const args = [
    '--listen',
    dirs.listen,
    '--dev',
    '--opkg',
    'stub',
    '--builtin-plugins-dir',
    dirs.builtinDir,
    '--data-dir',
    dirs.dataDir,
    '--user-plugins-dir',
    dirs.userDir,
  ];

  if (controllerURL !== undefined) {
    args.push('--controller-url', controllerURL);
  }

  return args;
}

/**
 * Decides how to launch the daemon: `go run ./cmd/mndwd` in a source checkout, otherwise an
 * explicit `--daemon <mndwd-binary>` (rejected before any process starts if it is missing).
 */
export function resolveDaemonLaunch(
  daemonArgs: string[],
  options: DevOptions,
  ctx: {daemonPackageDir: string | null; binaryExists: (path: string) => boolean},
): DaemonLaunch {
  if (ctx.daemonPackageDir !== null) {
    return {command: 'go', args: ['run', './cmd/mndwd', ...daemonArgs], cwd: ctx.daemonPackageDir};
  }

  if (options.daemonBinary !== undefined) {
    if (!ctx.binaryExists(options.daemonBinary)) {
      throw new CliError(`mndw dev: --daemon binary not found: ${options.daemonBinary}`);
    }

    return {command: options.daemonBinary, args: daemonArgs};
  }

  throw new CliError('mndw dev needs a source checkout (daemon/mndwd) or --daemon <mndwd-binary>');
}

/** Environment for the host dev server: sandbox source path, daemon URL, and plugin roots. */
export function buildHostEnv(params: HostEnvParams, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    MNDW_SANDBOX_PLUGIN: params.pluginSourceDir,
    MNDW_DAEMON: params.daemonUrl,
    MNDW_BUILTIN_PLUGINS_DIR: params.builtinDir,
    MNDW_USER_PLUGINS_DIR: params.userDir,
  };

  if (params.hostDevice !== undefined) {
    env.MNDW_HOST_DEVICE = params.hostDevice;
  }

  if (params.reloadSentinel !== undefined) {
    env.MNDW_DEV_RELOAD_SENTINEL = params.reloadSentinel;
  }

  return env;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls the daemon management list until the plugin appears (readiness) or the deadline passes. */
async function defaultWaitForDaemon(baseUrl: string, pluginName: string): Promise<void> {
  const deadline = Date.now() + 30_000;

  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/api/mgmt/list`);

      if (response.ok) {
        const data = await response.json() as {plugins?: Array<{name?: string}>};

        if (Array.isArray(data.plugins) && data.plugins.some((p) => p.name === pluginName)) {
          return;
        }
      }
    } catch {
      // Daemon not up yet; keep polling until the deadline.
    }

    if (Date.now() > deadline) {
      throw new CliError(`mndw dev: timed out waiting for mndwd at ${baseUrl}`);
    }

    await delay(250);
  }
}

/** Locates `daemon/mndwd` relative to this file, or null outside a source checkout. */
function defaultFindDaemonPackageDir(): string | null {
  const cliSourceDir = dirname(fileURLToPath(import.meta.url));
  const daemonDir = resolve(cliSourceDir, '..', '..', '..', 'daemon', 'mndwd');

  return existsSync(join(daemonDir, 'go.mod')) ? daemonDir : null;
}

/**
 * Builds every command under a plugin's Go backend before daemon launch. Skips plugins without
 * a `backend/go.mod` or `backend/cmd` directory. Returns a result indicating success, skip, or failure.
 */
const defaultGoBuildSpawn: GoBuildSpawn = (command, args, options) => {
  return crossSpawn.sync(command, args, {cwd: options.cwd, env: options.env, stdio: 'inherit'});
};

export interface BackendWatchOptions {
  readonly manifest: LoadedManifest['manifest'];
  readonly pluginSourceDir: string;
  readonly pluginName: string;
  readonly daemonUrl: string;
}

export interface BackendWatchDeps {
  readonly buildBackend?: (pluginSourceDir: string) => GoBuildResult;
  readonly watchBackend?: (options: WatchBuildOptions<GoBuildResult>) => WatchHandle;
  readonly restartService?: typeof defaultRestartService;
  readonly touchSentinel?: () => void;
  readonly fetch?: typeof fetch;
}

function backendWatchPaths(options: BackendWatchOptions): {paths: string[]; ignores: string[]} {
  const backend = options.manifest.backend;

  if (backend === undefined) {
    return {paths: [], ignores: []};
  }

  const backendDir = join(options.pluginSourceDir, 'backend');
  const paths = [join(backendDir, '**/*.go')];
  const ignores = [
    '**/.dev-data/**',
    join(backendDir, 'go.sum'),
    join(backendDir, '.cache', '**'),
    join(backendDir, '.gocache', '**'),
  ];

  try {
    const sourceDirectories = (directory: string): string[] => {
      const directories: string[] = [];

      for (const entry of readdirSync(directory, {withFileTypes: true})) {
        if (!entry.isDirectory() || ['.cache', '.gocache', 'dist', 'node_modules'].includes(entry.name)) {
          continue;
        }

        const child = join(directory, entry.name);

        directories.push(child, ...sourceDirectories(child));
      }

      return directories;
    };
    const commandDir = join(backendDir, 'cmd');

    paths.push(...sourceDirectories(backendDir));

    for (const entry of readdirSync(commandDir, {withFileTypes: true})) {
      if (entry.isDirectory()) {
        ignores.push(join(backendDir, entry.name));
      }
    }
  } catch {
    // Shell-only plugins may not have a Go command directory.
  }

  if (backend.kind === 'service') {
    paths.push(resolve(options.pluginSourceDir, backend.command));
  } else {
    for (const route of backend.routes) {
      paths.push(resolve(options.pluginSourceDir, route.command));
    }
  }

  return {paths: [...new Set(paths)], ignores: [...new Set(ignores)]};
}

function closedWatchHandle(): WatchHandle {
  return {onChange: () => undefined, close: () => Promise.resolve()};
}

/** Watches one plugin's declared backend sources and signals only after its artifact is live. */
export function watchPluginBackend(options: BackendWatchOptions, deps: BackendWatchDeps = {}): WatchHandle {
  if (options.manifest.backend === undefined) {
    return closedWatchHandle();
  }

  const buildBackend = deps.buildBackend ?? defaultBuildGoBackend;
  const watchBackend = deps.watchBackend ?? watchAndBuild;
  const restart = deps.restartService ?? defaultRestartService;
  const touchSentinel = deps.touchSentinel ?? (() => undefined);
  const fetchImpl = deps.fetch ?? fetch;
  const {paths, ignores} = backendWatchPaths(options);
  const backend: WatchBuildOptions<GoBuildResult> = {
    paths,
    ignore: ignores,
    build: () =>
      Promise.resolve(buildBackend(options.pluginSourceDir)).then((result) => {
        if (!result.success) {
          throw new CliError(`mndw dev: Go backend rebuild failed: ${result.error ?? 'unknown error'}`);
        }

        return result;
      }),
    onResult: async (result: BuildOutcome<GoBuildResult>, context) => {
      if (!result.ok) {
        console.error(`[mndw dev] Backend rebuild failed: ${result.error.message}`);

        return;
      }

      if (!context.isCurrent()) {
        return;
      }

      if (options.manifest.backend?.kind === 'service') {
        const restarted = await restart({
          daemonUrl: options.daemonUrl,
          pluginName: options.pluginName,
          timeoutMs: 5_000,
        }, {fetch: fetchImpl});

        if (!context.isCurrent()) {
          return;
        }

        if (!restarted) {
          console.error(`[mndw dev] Service restart failed for ${options.pluginName}; keeping last reload suppressed`);

          return;
        }
      }

      if (context.isCurrent()) {
        touchSentinel();
      }
    },
  };

  return watchBackend(backend);
}

export function defaultBuildGoBackend(
  pluginSourceDir: string,
  runBuild: GoBuildSpawn = defaultGoBuildSpawn,
): GoBuildResult {
  const backendDir = join(pluginSourceDir, 'backend');
  const goModPath = join(backendDir, 'go.mod');
  const cmdDir = join(backendDir, 'cmd');

  if (!existsSync(goModPath) || !existsSync(cmdDir)) {
    return {success: true, skipped: true};
  }

  const commandNames = readdirSync(cmdDir, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (commandNames.length === 0) {
    return {success: true, skipped: true};
  }

  try {
    for (const commandName of commandNames) {
      buildGoBackend({
        plugin: basename(resolve(pluginSourceDir)),
        backendDir,
        binaryName: commandName,
        entryPackage: `./cmd/${commandName}`,
        spawn: runBuild,
      });
    }
  } catch (error) {
    return {success: false, skipped: false, error: error instanceof Error ? error.message : String(error)};
  }

  return {success: true, skipped: false};
}

function defaultSpawn(
  command: string,
  args: string[],
  options: {cwd?: string; env?: NodeJS.ProcessEnv},
): DevChild {
  return crossSpawn(command, args, {stdio: 'inherit', cwd: options.cwd, env: options.env});
}

function defaultOnShutdownSignal(handler: () => void): void {
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

/**
 * Launches a full local development environment for one plugin: an isolated `mndwd --dev`
 * (serving the plugin's backend from a temp builtin root symlinked to its source) plus the
 * Vite host in sandbox mode (loading the plugin directly from source with HMR). Validates the
 * plugin first, tears both children down and removes only its own temp dirs on a shutdown
 * signal or either child exiting, and never copies source (symlink failure is fatal).
 */
export async function runDev(pluginDir: string, options: DevOptions = {}, deps: DevDeps = {}): Promise<void> {
  const repoRoot = deps.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const loadManifest = deps.readManifest ?? readManifest;
  const makeTempDir = deps.makeTempDir ?? ((prefix) => mkdtempSync(join(tmpdir(), prefix)));
  const symlinkDir = deps.symlinkDir ?? ((target, linkPath) => symlinkSync(target, linkPath, 'dir'));
  const removeDir = deps.removeDir ?? ((dir) => rmSync(dir, {recursive: true, force: true}));
  const spawn = deps.spawn ?? defaultSpawn;
  const waitForDaemon = deps.waitForDaemon ?? defaultWaitForDaemon;
  const onShutdownSignal = deps.onShutdownSignal ?? defaultOnShutdownSignal;
  const findDaemonPackageDir = deps.findDaemonPackageDir ?? defaultFindDaemonPackageDir;
  const fileExists = deps.fileExists ?? existsSync;
  const buildBackend = deps.buildGoBackend ?? defaultBuildGoBackend;
  const makeReloadSentinel = deps.createReloadSentinel ?? createReloadSentinel;
  const baseEnv = deps.env ?? process.env;

  // Validate before launching anything so a bad plugin fails fast with no side effects.
  const {manifest} = loadManifest(pluginDir);
  const pluginName = manifest.name;
  const pluginSourceDir = resolvePluginDir(pluginDir);

  const port = options.port ?? 9090;
  const listen = `127.0.0.1:${port}`;
  const daemonUrl = `http://127.0.0.1:${port}`;

  const tempDirs: string[] = [];
  const track = (dir: string): string => {
    tempDirs.push(dir);

    return dir;
  };
  const builtinDir = track(makeTempDir('mndw-dev-builtin-'));
  // Keep daemon-owned Unix socket paths below macOS's pathname limit when tmpdir() is nested.
  const dataDir = track(makeTempDir('d-'));
  const userDir = track(makeTempDir('mndw-dev-user-'));

  const cleanupDirs = (): void => {
    for (const dir of [...tempDirs].reverse()) {
      try {
        removeDir(dir);
      } catch {
        // Best-effort cleanup.
      }
    }
  };

  // Expose the plugin to the daemon as a builtin via a directory symlink to its source, so its
  // backend commands/services work while frontend is served from source.
  try {
    symlinkDir(pluginSourceDir, join(builtinDir, pluginName));
  } catch (err) {
    cleanupDirs();

    throw new CliError(
      `mndw dev could not symlink the plugin into a temporary builtin root: ${(err as Error).message}. `
        + 'Symlinks are required (source is never copied).',
    );
  }

  // Build Go backend (if present) before daemon launch so service commands find their binaries.
  const buildResult = buildBackend(pluginSourceDir);

  if (!buildResult.success) {
    cleanupDirs();

    throw new CliError(`mndw dev: Go backend build failed: ${buildResult.error ?? 'unknown error'}`);
  }

  if (!buildResult.skipped) {
    console.log('[mndw dev] Built Go backend');
  }

  const launch = resolveDaemonLaunch(
    buildDaemonArgs({listen, builtinDir, dataDir, userDir}, options.hostDevice),
    options,
    {
      daemonPackageDir: findDaemonPackageDir(),
      binaryExists: fileExists,
    },
  );

  const reloadSentinel = makeReloadSentinel(repoRoot);

  const children: DevChild[] = [];
  let watcher: WatchHandle | undefined;
  let resolveFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolveFinishedPromise) => {
    resolveFinished = resolveFinishedPromise;
  });
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): void => {
    if (shutdownPromise !== undefined) {
      return;
    }

    shuttingDown = true;

    for (const child of children) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Child may already be gone.
      }
    }

    shutdownPromise = (async () => {
      try {
        await watcher?.close();
      } catch (error) {
        console.error('[mndw dev] Failed to close backend watcher:', error);
      }

      reloadSentinel.cleanup();
      cleanupDirs();
      resolveFinished();
    })();
  };

  onShutdownSignal(shutdown);

  const daemon = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: {...baseEnv, MNDW_PLUGIN_RUNTIME_ROOT: join(dataDir, 'plugin-runtime')},
  });

  children.push(daemon);
  daemon.on('exit', shutdown);

  try {
    await waitForDaemon(daemonUrl, pluginName);
  } catch (err) {
    shutdown();
    await finished;

    throw err;
  }

  const hostEnv = buildHostEnv(
    {
      pluginSourceDir,
      daemonUrl,
      builtinDir,
      userDir,
      hostDevice: options.hostDevice,
      reloadSentinel: reloadSentinel.path,
    },
    baseEnv,
  );
  const host = spawn('pnpm', ['--filter', '@mndw/host', 'dev'], {env: hostEnv});

  children.push(host);
  host.on('exit', shutdown);

  if (!shuttingDown && manifest.backend !== undefined) {
    watcher = watchPluginBackend({
      manifest,
      pluginSourceDir,
      pluginName,
      daemonUrl,
    }, {
      buildBackend,
      touchSentinel: () => reloadSentinel.touch(),
      fetch: deps.fetch,
      restartService: deps.restartService,
      watchBackend: deps.watchBackend,
    });
  }

  await finished;
}
