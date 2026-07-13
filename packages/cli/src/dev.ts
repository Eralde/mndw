import {spawn as nodeSpawn} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {CliError} from './errors.js';
import {type LoadedManifest, readManifest} from './manifest.js';
import {resolvePluginDir} from './paths.js';

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
  env?: NodeJS.ProcessEnv;
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
}

/** The daemon argv for a `mndw dev` session: dev auth bypass, opkg stub, over the temp roots. */
export function buildDaemonArgs(dirs: DaemonDirs): string[] {
  return [
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

  throw new CliError('mndw dev needs a source checkout (packages/daemon) or --daemon <mndwd-binary>');
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

/** Locates `packages/daemon` relative to this file, or null outside a source checkout. */
function defaultFindDaemonPackageDir(): string | null {
  const daemonDir = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'daemon');

  return existsSync(join(daemonDir, 'go.mod')) ? daemonDir : null;
}

function defaultSpawn(
  command: string,
  args: string[],
  options: {cwd?: string; env?: NodeJS.ProcessEnv},
): DevChild {
  return nodeSpawn(command, args, {stdio: 'inherit', cwd: options.cwd, env: options.env});
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
  const loadManifest = deps.readManifest ?? readManifest;
  const makeTempDir = deps.makeTempDir ?? ((prefix) => mkdtempSync(join(tmpdir(), prefix)));
  const symlinkDir = deps.symlinkDir ?? ((target, linkPath) => symlinkSync(target, linkPath, 'dir'));
  const removeDir = deps.removeDir ?? ((dir) => rmSync(dir, {recursive: true, force: true}));
  const spawn = deps.spawn ?? defaultSpawn;
  const waitForDaemon = deps.waitForDaemon ?? defaultWaitForDaemon;
  const onShutdownSignal = deps.onShutdownSignal ?? defaultOnShutdownSignal;
  const findDaemonPackageDir = deps.findDaemonPackageDir ?? defaultFindDaemonPackageDir;
  const fileExists = deps.fileExists ?? existsSync;
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
  const dataDir = track(makeTempDir('mndw-dev-data-'));
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
  // backend (scripts/endpoints/daemon hooks) works while the frontend is served from source.
  try {
    symlinkDir(pluginSourceDir, join(builtinDir, pluginName));
  } catch (err) {
    cleanupDirs();

    throw new CliError(
      `mndw dev could not symlink the plugin into a temporary builtin root: ${(err as Error).message}. `
        + 'Symlinks are required (source is never copied).',
    );
  }

  const launch = resolveDaemonLaunch(buildDaemonArgs({listen, builtinDir, dataDir, userDir}), options, {
    daemonPackageDir: findDaemonPackageDir(),
    binaryExists: fileExists,
  });

  const children: DevChild[] = [];
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
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

    cleanupDirs();
  };

  onShutdownSignal(shutdown);

  const daemon = spawn(launch.command, launch.args, {cwd: launch.cwd, env: baseEnv});

  children.push(daemon);
  daemon.on('exit', shutdown);

  try {
    await waitForDaemon(daemonUrl, pluginName);
  } catch (err) {
    shutdown();

    throw err;
  }

  const hostEnv = buildHostEnv(
    {pluginSourceDir, daemonUrl, builtinDir, userDir, hostDevice: options.hostDevice},
    baseEnv,
  );
  const host = spawn('pnpm', ['--filter', '@mndw/host', 'dev'], {env: hostEnv});

  children.push(host);
  host.on('exit', shutdown);
}
