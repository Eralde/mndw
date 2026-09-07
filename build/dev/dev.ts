import {existsSync, mkdirSync, readFileSync, readdirSync} from 'node:fs';
import {relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import crossSpawn from 'cross-spawn';

import {
  buildBackend as buildBuiltinBackend,
  buildFrontend as buildBuiltinFrontend,
  buildOne as buildBuiltinOne,
  discoverBuiltinPlugins,
} from '../builtin-plugins.js';
import {restartService as defaultRestartService} from '../../tooling/cli/src/dev-reload.js';
import {type DevSessionDeps, runDevSession} from '../../tooling/cli/src/dev-session.js';
import {
  type BuildGenerationContext,
  type BuildOutcome,
  type WatchBuildOptions,
  type WatchHandle,
  watchAndBuild,
} from '../../tooling/cli/src/watch.js';
import {type LoadedManifest, readManifest} from '../../tooling/cli/src/manifest.js';

const DAEMON_URL = 'http://127.0.0.1:9090';

export interface DevDeps {
  readonly packBuiltinPlugins?: () => Promise<void>;
  readonly ensureDir?: (dir: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly repoRoot?: string;
  readonly watchBackend?: <T>(options: WatchBuildOptions<T>) => WatchHandle;
  readonly buildFrontend?: (name: string) => Promise<void>;
  readonly buildBackend?: (name: string) => Promise<void>;
  readonly buildOne?: (name: string) => Promise<void>;
  readonly restartService?: typeof defaultRestartService;
  readonly readManifest?: (pluginDir: string) => LoadedManifest;
  readonly session?: DevSessionDeps;
}

async function defaultPackBuiltinPlugins(repoRoot: string): Promise<void> {
  await new Promise<void>((resolvePack, rejectPack) => {
    const child = crossSpawn('pnpm', ['build-builtin-plugins', '--dev'], {cwd: repoRoot, stdio: 'inherit'});

    child.on('error', rejectPack);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePack();
      } else {
        rejectPack(new Error(`pnpm build-builtin-plugins --dev exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}

export interface BuiltinWatchOptions {
  readonly sourceRoot: string;
  readonly distRoot: string;
  readonly pluginNames: readonly string[];
  readonly daemonUrl: string;
  readonly development?: boolean;
}

export interface BuiltinWatchDeps {
  readonly watchBackend?: <T>(options: WatchBuildOptions<T>) => WatchHandle;
  readonly buildFrontend?: (name: string) => Promise<void>;
  readonly buildBackend?: (name: string) => Promise<void>;
  readonly buildOne?: (name: string) => Promise<void>;
  readonly readManifest?: (pluginDir: string) => LoadedManifest;
  readonly restartService?: typeof defaultRestartService;
  readonly touchSentinel?: () => void;
  readonly fetch?: typeof fetch;
}

interface BuiltinBuildResult {
  readonly plugins: readonly {readonly name: string; readonly backendChanged: boolean}[];
}

function buildWatchPaths(
  pluginNames: readonly string[],
  sourceRoot: string,
  loadManifest: (pluginDir: string) => LoadedManifest,
): {paths: string[]; ignores: string[]} {
  const paths: string[] = [];
  const ignores: string[] = [];

  for (const name of pluginNames) {
    const pluginDir = resolve(sourceRoot, name);
    const backendDir = resolve(pluginDir, 'backend');

    paths.push(
      resolve(pluginDir, 'src'),
      resolve(pluginDir, 'src/**/*'),
      resolve(pluginDir, 'manifest.json'),
      resolve(pluginDir, 'package.json'),
      resolve(pluginDir, 'backend/**/*.go'),
    );

    const addSourceDirectories = (directory: string): void => {
      for (const entry of readdirSync(directory, {withFileTypes: true})) {
        if (entry.isDirectory()) {
          if (['.cache', '.gocache', 'dist', 'node_modules'].includes(entry.name)) {
            continue;
          }

          const child = resolve(directory, entry.name);

          paths.push(child);
          addSourceDirectories(child);
        } else if (entry.name.endsWith('.go')) {
          paths.push(resolve(directory, entry.name));
        }
      }
    };

    try {
      addSourceDirectories(backendDir);
    } catch {
      // Frontend-only plugins may not have a backend directory.
    }

    ignores.push(
      resolve(backendDir, 'go.sum'),
      resolve(backendDir, '.cache/**'),
      resolve(backendDir, '.gocache/**'),
    );

    try {
      for (const entry of readdirSync(resolve(backendDir, 'cmd'), {withFileTypes: true})) {
        if (entry.isDirectory()) {
          ignores.push(resolve(backendDir, entry.name));
        }
      }
    } catch {
      // Frontend-only and shell-only plugins may not have a Go command directory.
    }

    const {manifest} = loadManifest(pluginDir);
    const backend = manifest.backend;

    let hasBackendBuildHook = false;

    try {
      const packageContents = JSON.parse(readFileSync(resolve(pluginDir, 'package.json'), 'utf8')) as {
        readonly mndw?: {readonly backendBuildScript?: unknown};
      };

      hasBackendBuildHook = typeof packageContents.mndw?.backendBuildScript === 'string';
    } catch {
      // The initial pack validates package metadata; path discovery stays usable for test seams.
    }

    if (backend?.kind === 'service') {
      const commandPath = resolve(pluginDir, backend.command);

      paths.push(commandPath);

      if (hasBackendBuildHook) {
        ignores.push(commandPath);
      }
    } else if (backend?.kind === 'exec') {
      for (const route of backend.routes) {
        const commandPath = resolve(pluginDir, route.command);

        paths.push(commandPath);

        if (hasBackendBuildHook) {
          ignores.push(commandPath);
        }
      }
    }
  }

  return {paths: [...new Set(paths)], ignores: [...new Set(ignores)]};
}

async function buildChangedBuiltinPlugins(
  changedPaths: readonly string[],
  options: BuiltinWatchOptions,
  deps: Required<Pick<BuiltinWatchDeps, 'buildFrontend' | 'buildBackend' | 'buildOne'>>,
): Promise<BuiltinBuildResult> {
  const knownNames = new Set(options.pluginNames);
  const changes = new Map<string, {frontend: boolean; backend: boolean}>();

  for (const changedPath of changedPaths) {
    const relativePath = relative(options.sourceRoot, resolve(changedPath));
    const [name, ...pluginRelativeParts] = relativePath.split(sep);

    if (name === undefined || !knownNames.has(name) || pluginRelativeParts.length === 0) {
      continue;
    }

    const entry = changes.get(name) ?? {frontend: false, backend: false};
    const backendChanged = pluginRelativeParts[0] === 'backend';

    if (backendChanged) {
      entry.backend = true;
    } else {
      entry.frontend = true;
    }

    changes.set(name, entry);
  }

  const builds = options.pluginNames.map(async (name): Promise<{name: string; backendChanged: boolean} | undefined> => {
    const change = changes.get(name);

    if (change === undefined) {
      return undefined;
    }

    if (change.frontend && change.backend) {
      await deps.buildOne(name);
    } else if (change.backend) {
      await deps.buildBackend(name);
    } else {
      await deps.buildFrontend(name);
    }

    return {name, backendChanged: change.backend};
  });
  const results = await Promise.allSettled(builds);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');

  if (failed !== undefined) {
    throw failed.reason;
  }

  return {
    plugins: results
      .filter((result): result is PromiseFulfilledResult<{name: string; backendChanged: boolean} | undefined> =>
        result.status === 'fulfilled'
      )
      .flatMap((result) => result.value === undefined ? [] : [result.value]),
  };
}

/** Watches source-only builtin trees and gates one reload sentinel on service restarts. */
export function watchBuiltinPlugins(options: BuiltinWatchOptions, deps: BuiltinWatchDeps = {}): WatchHandle {
  const development = options.development ?? true;
  const loadManifest = deps.readManifest ?? readManifest;
  const {paths: sourcePaths, ignores} = buildWatchPaths(options.pluginNames, options.sourceRoot, loadManifest);
  const buildFrontend = deps.buildFrontend ?? ((name) =>
    buildBuiltinFrontend(name, {
      sourceRoot: options.sourceRoot,
      distRoot: options.distRoot,
      development,
    }));
  const buildBackend = deps.buildBackend ?? ((name) =>
    buildBuiltinBackend(name, {
      sourceRoot: options.sourceRoot,
      distRoot: options.distRoot,
      development,
    }));
  const buildOne = deps.buildOne ?? ((name) =>
    buildBuiltinOne(name, {
      sourceRoot: options.sourceRoot,
      distRoot: options.distRoot,
      development,
    }));
  const watchBackend = deps.watchBackend ?? watchAndBuild;
  const restartService = deps.restartService ?? defaultRestartService;
  const touchSentinel = deps.touchSentinel ?? (() => undefined);
  const fetchImpl = deps.fetch ?? fetch;
  const buildDeps = {buildFrontend, buildBackend, buildOne};
  const build: WatchBuildOptions<BuiltinBuildResult> = {
    paths: sourcePaths,
    ignore: ignores,
    build: (changed) => buildChangedBuiltinPlugins(changed, options, buildDeps),
    onResult: async (result: BuildOutcome<BuiltinBuildResult>, context: BuildGenerationContext) => {
      if (!result.ok) {
        console.error(`[mndw dev] Builtin repack failed: ${result.error.message}`);

        return;
      }

      if (!context.isCurrent()) {
        return;
      }

      const servicePlugins = result.value.plugins.filter((plugin) => {
        if (!plugin.backendChanged) {
          return false;
        }

        const manifest = loadManifest(resolve(options.sourceRoot, plugin.name)).manifest;

        return manifest.backend?.kind === 'service';
      });

      if (!context.isCurrent()) {
        return;
      }

      const restartResults = await Promise.all(servicePlugins.map(async (plugin) => {
        try {
          return await restartService({
            daemonUrl: options.daemonUrl,
            pluginName: plugin.name,
            timeoutMs: 5_000,
          }, {fetch: fetchImpl});
        } catch {
          return false;
        }
      }));

      if (!context.isCurrent()) {
        return;
      }

      if (restartResults.some((restarted) => !restarted)) {
        console.error('[mndw dev] One or more builtin service restarts failed; keeping last reload suppressed');

        return;
      }

      touchSentinel();
    },
  };

  return watchBackend(build);
}

/** Starts packed built-in plugins, local mndwd, then Vite through the shared dev session. */
export async function runDev(deps: DevDeps = {}): Promise<void> {
  const repoRoot = deps.repoRoot ?? resolve(import.meta.dirname, '..', '..');
  const env = deps.env ?? process.env;
  const builtinSourceRoot = resolve(repoRoot, 'plugins/builtin');
  const builtinDir = resolve(repoRoot, 'plugins/builtin', 'dist');
  const dataDir = resolve(repoRoot, '.dev-data');
  const userDir = resolve(dataDir, 'user-plugins');
  const packBuiltinPlugins = deps.packBuiltinPlugins ?? (() => defaultPackBuiltinPlugins(repoRoot));
  const ensureDir = deps.ensureDir ?? ((dir) => mkdirSync(dir, {recursive: true}));

  await packBuiltinPlugins();
  ensureDir(dataDir);
  ensureDir(userDir);

  const pluginNames = existsSync(builtinSourceRoot) ? discoverBuiltinPlugins(builtinSourceRoot) : [];
  const watchDeps: BuiltinWatchDeps = {
    watchBackend: deps.watchBackend,
    buildFrontend: deps.buildFrontend ?? ((name) =>
      buildBuiltinFrontend(name, {
        sourceRoot: builtinSourceRoot,
        distRoot: builtinDir,
        development: true,
        repoRoot,
      })),
    buildBackend: deps.buildBackend ?? ((name) =>
      buildBuiltinBackend(name, {
        sourceRoot: builtinSourceRoot,
        distRoot: builtinDir,
        development: true,
        repoRoot,
      })),
    buildOne: deps.buildOne ?? ((name) =>
      buildBuiltinOne(name, {
        sourceRoot: builtinSourceRoot,
        distRoot: builtinDir,
        development: true,
        repoRoot,
      })),
    readManifest: deps.readManifest,
    restartService: deps.restartService,
    fetch: deps.session?.fetch,
  };

  await runDevSession({
    repoRoot,
    daemon: {
      command: 'go',
      args: ['run', './cmd/mndwd'],
      cwd: resolve(repoRoot, 'daemon', 'mndwd'),
    },
    listen: '127.0.0.1:9090',
    daemonUrl: DAEMON_URL,
    builtinDir,
    dataDir,
    userDir,
    env,
    hostDevice: env.MNDW_HOST_DEVICE,
    isReady: () => true,
    createWatcher: ({daemonUrl, touchSentinel}) => {
      return watchBuiltinPlugins({
        sourceRoot: builtinSourceRoot,
        distRoot: builtinDir,
        pluginNames,
        daemonUrl,
        development: true,
      }, {...watchDeps, touchSentinel});
    },
  }, deps.session);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runDev().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
