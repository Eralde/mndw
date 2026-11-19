import type {MndwPlugin} from '@mndw/sdk';
import {type PluginManifest, validateManifest} from '@mndw/sdk-internal';
import {type PluginCatalogService, createPluginCatalogSource} from '../services/plugin-catalog.service.js';
import {appState} from '../state/app.svelte.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import type {LoadedPlugin} from './plugin-registry.js';
import type {PluginBackendDescriptor, PluginListEntry} from './plugin-types.js';
import type {PluginContextServices} from './plugin-context.js';
import {
  applyPluginListSnapshot,
  getPluginLoadState,
  replacePluginLoadStates,
  setPluginLoadCatalog,
  setPluginLoadListOutcome,
  setPluginLoadState,
} from './plugin-load-state.svelte.js';

/** Window event the sandbox HMR transaction dispatches so the active page host remounts. */
export const SANDBOX_RELOAD_EVENT = 'mndw:sandbox-reloaded';

/**
 * Detail of {@link SANDBOX_RELOAD_EVENT}. Carries the candidate and prior loaded plugins
 * explicitly (not via the registry, whose module has already been swapped) so a page host
 * can remount the candidate and roll back to the prior module on its own without racing the
 * registry. A matching host registers a `Promise<boolean>` reporting its remount outcome so
 * the transaction can await it before committing.
 */
export interface SandboxReloadDetail {
  pluginName: string;
  next: LoadedPlugin;
  prior: LoadedPlugin;
  register(result: Promise<boolean>): void;
}

/** The registry surface the loader needs; a subset so tests can pass a fresh registry. */
export interface SandboxRegistry {
  register(plugin: LoadedPlugin): void;
  replace(plugin: LoadedPlugin): LoadedPlugin;
  get(name: string): LoadedPlugin | undefined;
  clear(): void;
}

/**
 * How the loader reaches the Vite virtual modules. Kept as injected functions (never a
 * literal `import('virtual:…')` inside this module) so vitest — which has no sandbox Vite
 * plugin — can transform this file; the real `virtual:` specifiers live in `sandbox-virtual.ts`.
 */
export interface SandboxImports {
  importPluginModule: () => Promise<unknown>;
  importManifestModule: () => Promise<{default?: unknown; __catalogBaseUrl?: string}>;
}

/** Injected boundaries so the loader is unit-testable without Vite virtual modules or the DOM. */
export interface SandboxLoaderDeps extends SandboxImports {
  isCurrent?: () => boolean;
  catalogBaseUrl?: string;
  registry: SandboxRegistry;
  catalogService: PluginCatalogService;
  getLocale: () => string;
  pluginContextServices: PluginContextServices;
  remountWidgets?: (
    name: string,
    next: LoadedPlugin,
    prior: LoadedPlugin,
    registry: SandboxRegistry,
    pluginContextServices: PluginContextServices,
  ) => Promise<boolean>;
  reloadPage?: (name: string, next: LoadedPlugin, prior: LoadedPlugin) => Promise<boolean>;
}

/** Outcome of a hot-reload transaction, exposed for tests and logging. */
export type SandboxReloadResult = 'reloaded' | 'restart-required' | 'failed';

function validateModule(module: unknown): MndwPlugin {
  const m = module as Record<string, unknown>;

  if (typeof m.createInstance !== 'function') {
    throw new Error('Sandbox plugin does not export { createInstance }');
  }

  return m as unknown as MndwPlugin;
}

/** Projects a manifest's optional backend into the client-facing descriptor shape. */
function descriptorFromManifest(backend: PluginManifest['backend'] | undefined): PluginBackendDescriptor {
  const routes: NonNullable<PluginBackendDescriptor['routes']> = {};

  if (backend === undefined) {
    return {routes};
  }

  for (const route of backend.routes) {
    routes[route.id] = route.transport === 'http'
      ? {transport: 'http', method: route.method, path: route.path}
      : {transport: 'websocket', path: route.path,
        ...(route.protocols === undefined ? {} : {protocols: route.protocols})};
  }

  return {routes};
}

/**
 * Builds the runtime {@link PluginListEntry} the host consumes from a validated sandbox
 * manifest. A sandbox plugin is always treated as an approved+enabled builtin — the daemon
 * is bypassed in `mndw dev`, so there is no approval flow.
 */
export function manifestToListEntry(manifest: PluginManifest, catalogBaseUrl?: string): PluginListEntry {
  const base = {
    name: manifest.name,
    version: manifest.version,
    label: manifest.label,
    ...(manifest.description === undefined ? {} : {description: manifest.description}),
    entry: manifest.entry,
    ...(manifest.i18n === undefined ? {} : {i18n: manifest.i18n}),
    ...(catalogBaseUrl === undefined ? {} : {catalogBaseUrl}),
    source: 'builtin' as const,
    approval: 'approved' as const,
    enabled: true,
    depsStatus: 'ready' as const,
    backend: descriptorFromManifest(manifest.backend),
  };

  if (manifest.type === 'widget') {
    return {
      ...base,
      type: 'widget',
      size: manifest.size,
      ...(manifest.fixedHeight === true ? {fixedHeight: true} : {}),
    };
  }

  return {...base, type: 'page', route: manifest.route};
}

async function buildLoadedPlugin(
  deps: SandboxLoaderDeps,
  knownEntry?: PluginListEntry,
  isCurrent: () => boolean = () => true,
): Promise<LoadedPlugin> {
  let entry = knownEntry;

  if (entry === undefined) {
    const manifestModule = await deps.importManifestModule();

    if (manifestModule.default === undefined || manifestModule.default === null) {
      throw new Error('Sandbox manifest module has no default export');
    }

    const manifest = validateManifest(manifestModule.default);
    const catalogBaseUrl = deps.catalogBaseUrl ?? manifestModule.__catalogBaseUrl;

    entry = manifestToListEntry(manifest, catalogBaseUrl);
  }

  const catalogService = deps.catalogService;
  const localeOf = deps.getLocale;
  const source = createPluginCatalogSource(
    entry.name,
    entry.version,
    entry.catalogBaseUrl ?? `/plugins/${entry.name}`,
    entry.i18n,
  );
  const catalog = source === undefined ? undefined : catalogService.createPluginCatalogCell(source, localeOf());

  if (catalog !== undefined) {
    await catalogService.loadInitialPluginCatalog(catalog, localeOf());
  }

  if (isCurrent()) {
    setPluginLoadCatalog(entry.name, catalog);
  }

  const module = validateModule(await deps.importPluginModule());

  return {entry, module, ...(catalog === undefined ? {} : {catalog})};
}

interface ActiveSandboxRun {
  deps: SandboxLoaderDeps;
  entry: PluginListEntry;
  isCurrent: () => boolean;
}

let activeSandboxRun: ActiveSandboxRun | undefined;
let sandboxOperationToken = 0;
const sandboxRetryPromises = new Map<string, Promise<boolean>>();

function claimSandboxOperation(): number {
  sandboxOperationToken += 1;

  return sandboxOperationToken;
}

function ownsSandboxOperation(token: number, isCurrent: () => boolean): boolean {
  return token === sandboxOperationToken && isCurrent();
}

/**
 * Sandbox-mode counterpart to {@link loadPlugins}: its list is the single validated
 * manifest. Publish that list before importing plugin code so a code failure is represented
 * by per-plugin load state and remains addable/removable from the dashboard.
 */
export async function loadSandboxPlugin(deps: SandboxLoaderDeps): Promise<void> {
  const registry = deps.registry;
  const isCurrent = (): boolean => deps.isCurrent === undefined || deps.isCurrent();

  if (!isCurrent()) {
    return;
  }

  const operation = claimSandboxOperation();
  const ownsOperation = (): boolean => ownsSandboxOperation(operation, isCurrent);

  if (!ownsOperation()) {
    return;
  }

  activeSandboxRun = undefined;
  sandboxRetryPromises.clear();
  setPluginLoadListOutcome('pending');
  replacePluginLoadStates([]);
  replaceDepsStatuses([]);
  registry.clear();

  let entry: PluginListEntry | undefined;

  try {
    const manifestModule = await deps.importManifestModule();

    if (manifestModule.default === undefined || manifestModule.default === null) {
      throw new Error('Sandbox manifest module has no default export');
    }

    const manifest = validateManifest(manifestModule.default);

    entry = manifestToListEntry(manifest, deps.catalogBaseUrl ?? manifestModule.__catalogBaseUrl);

    if (!ownsOperation()) {
      return;
    }

    replaceDepsStatuses([entry]);
    applyPluginListSnapshot([entry]);
    setPluginLoadListOutcome('ok');
    appState.pluginLoadError = null;

    const runDeps = {...deps, isCurrent};

    activeSandboxRun = {deps: runDeps, entry, isCurrent};

    const plugin = await buildLoadedPlugin(deps, entry, ownsOperation);

    if (!ownsOperation()) {
      return;
    }

    registry.register(plugin);
    setPluginLoadState(entry.name, 'loaded');
    console.log(`[mndw] Sandbox plugin loaded: ${plugin.entry.name}`);
  } catch (err) {
    if (!ownsOperation()) {
      return;
    }

    if (entry === undefined) {
      appState.pluginLoadError = 'list';
      setPluginLoadListOutcome('failed');
    } else {
      setPluginLoadState(entry.name, 'failed', 'error');
    }

    console.error('[mndw] Failed to load sandbox plugin:', err);
  }
}

/** Retries a failed sandbox plugin while keeping the already successful manifest list. */
export async function retrySandboxPlugin(name: string): Promise<boolean> {
  const run = activeSandboxRun;
  const state = getPluginLoadState(name);

  if (
    run?.entry.name !== name
    || state?.runnable !== true
    || state.status !== 'failed'
    || !run.isCurrent()
  ) {
    return false;
  }

  const existing = sandboxRetryPromises.get(name);

  if (existing !== undefined) {
    return existing;
  }

  const operation = claimSandboxOperation();
  const ownsOperation = (): boolean => activeSandboxRun === run && ownsSandboxOperation(operation, run.isCurrent);

  if (!ownsOperation()) {
    return false;
  }

  setPluginLoadState(name, 'loading');

  const retry = (async (): Promise<boolean> => {
    try {
      const plugin = await buildLoadedPlugin(run.deps, run.entry, ownsOperation);

      if (!ownsOperation()) {
        return false;
      }

      if (run.deps.registry.get(name) === undefined) {
        run.deps.registry.register(plugin);
      }

      setPluginLoadState(name, 'loaded');

      return true;
    } catch (err) {
      if (ownsOperation()) {
        setPluginLoadState(name, 'failed', 'error');
        console.error('[mndw] Failed to retry sandbox plugin:', err);
      }

      return false;
    }
  })().finally(() => {
    if (sandboxRetryPromises.get(name) === retry) {
      sandboxRetryPromises.delete(name);
    }
  });

  sandboxRetryPromises.set(name, retry);

  return retry;
}

/**
 * Runs one hot-reload transaction. Rebuilds and validates the candidate, then (only when
 * compatible: same name, type, and page route) swaps the registry module and remounts every
 * affected widget tile and the active page in place, awaiting each. On any failure the
 * registry is rolled back to the prior module and the previous live plugin is retained;
 * a topology-changing manifest returns `restart-required` without disturbing the live plugin.
 */
export async function reloadSandboxPlugin(deps: SandboxLoaderDeps): Promise<SandboxReloadResult> {
  const registry = deps.registry;
  const remountWidgets = deps.remountWidgets ?? defaultRemountWidgets;
  const reloadPage = deps.reloadPage ?? defaultReloadPage;
  const pluginContextServices = deps.pluginContextServices;
  const isCurrent = deps.isCurrent ?? activeSandboxRun?.isCurrent ?? (() => true);
  const reloadDeps = deps.isCurrent === undefined ? {...deps, isCurrent} : deps;

  if (!isCurrent()) {
    return 'failed';
  }

  let candidate: LoadedPlugin;

  try {
    candidate = await buildLoadedPlugin(reloadDeps, undefined, isCurrent);
  } catch (err) {
    if (!isCurrent()) {
      return 'failed';
    }

    console.error('[mndw] Sandbox reload rejected (invalid update kept previous plugin):', err);

    return 'failed';
  }

  if (!isCurrent()) {
    return 'failed';
  }

  const name = candidate.entry.name;
  const prior = registry.get(name);

  if (prior === undefined) {
    // Never loaded (e.g. the first load failed): treat the update as a fresh load.
    const operation = claimSandboxOperation();
    const ownsOperation = (): boolean => ownsSandboxOperation(operation, isCurrent);

    if (!ownsOperation()) {
      return 'failed';
    }

    registry.register(candidate);
    replaceDepsStatuses([candidate.entry]);
    applyPluginListSnapshot([candidate.entry]);
    setPluginLoadListOutcome('ok');
    setPluginLoadState(name, 'loaded');
    appState.pluginLoadError = null;
    activeSandboxRun = {deps: reloadDeps, entry: candidate.entry, isCurrent};

    return 'reloaded';
  }

  const operation = claimSandboxOperation();
  const ownsOperation = (): boolean => ownsSandboxOperation(operation, isCurrent);

  if (!ownsOperation()) {
    return 'failed';
  }

  const priorRun = activeSandboxRun;
  let restored: LoadedPlugin;

  try {
    restored = registry.replace(candidate);
  } catch (err) {
    console.error(`[mndw] Sandbox reload needs a restart of \`mndw dev\`: ${(err as Error).message}`);

    return 'restart-required';
  }

  activeSandboxRun = {deps: reloadDeps, entry: candidate.entry, isCurrent};

  try {
    const widgetsOk = await remountWidgets(name, candidate, prior, registry, pluginContextServices);

    if (!ownsOperation()) {
      return 'failed';
    }

    const pageOk = await reloadPage(name, candidate, prior);

    if (!ownsOperation()) {
      return 'failed';
    }

    if (!widgetsOk || !pageOk) {
      throw new Error('a widget or page remount reported failure');
    }

    setPluginLoadState(name, 'loaded');

    console.log(`[mndw] Sandbox plugin reloaded: ${name}`);

    return 'reloaded';
  } catch (err) {
    if (!ownsOperation()) {
      return 'failed';
    }

    registry.replace(restored);
    activeSandboxRun = priorRun;
    console.error(`[mndw] Sandbox reload failed, kept previous plugin "${name}":`, err);

    return 'failed';
  }
}

/** Default widget remount: lazily reaches the grid setup so this module stays DOM-free for tests. */
async function defaultRemountWidgets(
  name: string,
  next: LoadedPlugin,
  prior: LoadedPlugin,
  registry: SandboxRegistry,
  pluginContextServices: PluginContextServices,
): Promise<boolean> {
  const {remountWidgetTiles} = await import('../dashboard/tile-controller.js');

  return remountWidgetTiles(pluginContextServices, registry, name, next, prior);
}

/** Default page reload: dispatches the reload event and awaits any matching page host's report. */
async function defaultReloadPage(name: string, next: LoadedPlugin, prior: LoadedPlugin): Promise<boolean> {
  const results: Array<Promise<boolean>> = [];
  const detail: SandboxReloadDetail = {
    pluginName: name,
    next,
    prior,
    register: (result) => results.push(result),
  };

  window.dispatchEvent(new CustomEvent(SANDBOX_RELOAD_EVENT, {detail}));

  const settled = await Promise.all(results);

  return settled.every(Boolean);
}
