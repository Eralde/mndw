import {existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import crossSpawn from 'cross-spawn';
import {CliError} from './errors.js';
import {restartService as defaultRestartService} from './dev-reload.js';
import {type DevSessionDeps, runDevSession} from './dev-session.js';
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

/** Injectable boundaries so the supervisor is unit-testable without real processes or fs. */
export interface DevDeps {
  readManifest?: (pluginDir: string) => LoadedManifest;
  makeTempDir?: (prefix: string) => string;
  symlinkDir?: (target: string, linkPath: string) => void;
  removeDir?: (dir: string) => void;
  findDaemonPackageDir?: () => string | null;
  fileExists?: (path: string) => boolean;
  buildGoBackend?: (pluginSourceDir: string) => GoBuildResult;
  repoRoot?: string;
  watchBackend?: (options: WatchBuildOptions<GoBuildResult>) => WatchHandle;
  restartService?: typeof defaultRestartService;
  env?: NodeJS.ProcessEnv;
  session?: DevSessionDeps;
}

/** Outcome of a Go backend build attempt. */
export interface GoBuildResult {
  readonly success: boolean;
  readonly skipped: boolean;
  readonly error?: string;
}

export interface DaemonLaunch {
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
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
  const findDaemonPackageDir = deps.findDaemonPackageDir ?? defaultFindDaemonPackageDir;
  const fileExists = deps.fileExists ?? existsSync;
  const buildBackend = deps.buildGoBackend ?? defaultBuildGoBackend;
  const baseEnv = deps.env ?? process.env;
  const hostDevice = options.hostDevice ?? baseEnv.MNDW_HOST_DEVICE;

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
  const cleanupDirs = (): void => {
    for (const dir of [...tempDirs].reverse()) {
      try {
        removeDir(dir);
      } catch {
        // Best-effort cleanup.
      }
    }
  };

  try {
    const builtinDir = track(makeTempDir('mndw-dev-builtin-'));
    // Keep daemon-owned Unix socket paths below macOS's pathname limit when tmpdir() is nested.
    const dataDir = track(makeTempDir('d-'));
    const userDir = track(makeTempDir('mndw-dev-user-'));

    // Expose plugin to daemon as builtin via directory symlink to its source.
    try {
      symlinkDir(pluginSourceDir, join(builtinDir, pluginName));
    } catch (err) {
      throw new CliError(
        `mndw dev could not symlink the plugin into a temporary builtin root: ${(err as Error).message}. `
          + 'Symlinks are required (source is never copied).',
      );
    }

    // Build Go backend (if present) before daemon launch so service commands find their binaries.
    const buildResult = buildBackend(pluginSourceDir);

    if (!buildResult.success) {
      throw new CliError(`mndw dev: Go backend build failed: ${buildResult.error ?? 'unknown error'}`);
    }

    if (!buildResult.skipped) {
      console.log('[mndw dev] Built Go backend');
    }

    const launch = resolveDaemonLaunch([], options, {
      daemonPackageDir: findDaemonPackageDir(),
      binaryExists: fileExists,
    });

    const isReady = (payload: unknown): boolean => {
      if (typeof payload !== 'object' || payload === null || !('plugins' in payload)) {
        return false;
      }

      return Array.isArray(payload.plugins) && payload.plugins.some((plugin: unknown) => {
        return typeof plugin === 'object' && plugin !== null && 'name' in plugin && plugin.name === pluginName;
      });
    };

    await runDevSession({
      repoRoot,
      daemon: launch,
      listen,
      daemonUrl,
      builtinDir,
      dataDir,
      userDir,
      env: baseEnv,
      hostDevice,
      sandboxPlugin: pluginSourceDir,
      isReady,
      createWatcher: ({daemonUrl: watcherDaemonUrl, touchSentinel}) => {
        return watchPluginBackend({
          manifest,
          pluginSourceDir,
          pluginName,
          daemonUrl: watcherDaemonUrl,
        }, {
          buildBackend,
          touchSentinel,
          fetch: deps.session?.fetch,
          restartService: deps.restartService,
          watchBackend: deps.watchBackend,
        });
      },
    }, deps.session);
  } finally {
    cleanupDirs();
  }
}
