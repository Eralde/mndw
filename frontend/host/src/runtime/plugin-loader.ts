import type {MndwPlugin} from '@mndw/sdk';
import {MGMT_LIST_TIMEOUT_MS, MGMT_LIST_URL, PLUGIN_SOURCE_PATHS} from '../constants.js';
import {appState, getAuthRunGeneration, getAuthRunSignal} from '../state/app.svelte.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {getLocale} from '../services/locale.service.js';
import {pristineFetch} from '../services/pristine-fetch.js';
import {
  type PluginCatalogService,
  createPluginCatalogSource,
  pluginCatalogService,
} from '../services/plugin-catalog.service.js';
import {checkPluginVersions, readPluginLock} from './plugin-lock.js';
import {type PluginRegistry, pluginRegistry} from './plugin-registry.js';
import {decodeMgmtList} from './mgmt-list-schema.js';
import type {PluginListEntry} from './plugin-types.js';
import {clearPluginVersionWarnings, setPluginVersionWarnings} from './plugin-version-warnings.svelte.js';
import {
  beginPluginLoadRetry,
  dismissPluginLoadFailureToast,
  finishPluginLoadRetry,
  resetPluginLoadFailureToast,
  syncPluginLoadFailureToast,
} from './plugin-load-toast.svelte.js';
import {
  type PluginLoadFailureKind,
  applyPluginListSnapshot,
  getPluginLoadState,
  getPluginLoadStates,
  replacePluginLoadStates,
  setPluginLoadCatalog,
  setPluginLoadListOutcome,
  setPluginLoadState,
} from './plugin-load-state.svelte.js';

/**
 * Injectable dependencies so the loader is unit-testable without real HTTP or DOM. In
 * production the defaults fetch the daemon list, dynamic-import the plugin module, and
 * inject the per-plugin stylesheet.
 */
export interface LoaderDeps {
  fetchList?: (signal: AbortSignal) => Promise<PluginListEntry[]>;
  importModule?: (url: string) => Promise<unknown>;
  loadStylesheet?: (href: string, pluginName: string) => Promise<void>;
  checkVersions?: (entry: PluginListEntry, dir: string) => string[] | Promise<string[]>;
  catalogService?: PluginCatalogService;
  registry?: Pick<PluginRegistry, 'register' | 'clear' | 'get' | 'remove'>;
  getLocale?: () => string;
  loadTimeoutMs?: number;
}

let loadGeneration = 0;
let activeListController: AbortController | undefined;
let activePluginLoadToastAuthBinding: {
  signal: AbortSignal;
  handler: () => void;
} | undefined;

/**
 * Upper bound for one plugin's stylesheet, module import and initial catalog. A plugin that
 * never settles (hung request, endless top-level await) must not keep the shell from mounting.
 */
export const PLUGIN_LOAD_TIMEOUT_MS = 15_000;

const loadedPluginStylesheets = new Set<string>();

function versionedAssetUrl(dir: string, asset: string, version: string): string {
  return `${dir}/${asset}?v=${encodeURIComponent(version)}`;
}

/**
 * Injects a plugin's optional stylesheet once. A missing stylesheet is not an error
 * (plugins may ship none) — it resolves either way.
 */
async function ensurePluginStylesheet(href: string, pluginName: string): Promise<void> {
  if (loadedPluginStylesheets.has(href)) {
    return;
  }

  await new Promise<void>((resolve) => {
    const existing = document.querySelector(`link[data-plugin-style="${pluginName}"][href="${href}"]`);

    if (existing) {
      loadedPluginStylesheets.add(href);
      resolve();

      return;
    }

    const link = document.createElement('link');

    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.pluginStyle = pluginName;

    link.onload = () => {
      loadedPluginStylesheets.add(href);
      resolve();
    };

    link.onerror = () => {
      console.warn(`[mndw] No stylesheet for plugin "${pluginName}" at ${href}`);
      resolve();
    };

    document.head.appendChild(link);
  });
}

function validateModule(module: unknown, name: string): MndwPlugin {
  const m = module as Record<string, unknown>;

  if (typeof m.createInstance !== 'function') {
    throw new Error(`Plugin "${name}" does not export { createInstance }`);
  }

  return m as unknown as MndwPlugin;
}

async function defaultFetchList(signal: AbortSignal): Promise<PluginListEntry[]> {
  // No deadline here: the loader's own `Promise.race` below covers the fetch AND the body
  // read (this promise resolves only after `response.json()` settles), so one timer rules.
  const response = await pristineFetch(MGMT_LIST_URL, {signal});

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return decodeMgmtList(await response.json());
}

async function defaultCheckVersions(entry: PluginListEntry, dir: string): Promise<string[]> {
  const lock = await readPluginLock(dir);

  if (!lock) {
    return [];
  }

  return checkPluginVersions(entry.name, lock);
}

/** Drops duplicate plugin names, and duplicate page routes, keeping the first seen. */
function dedupe(entries: PluginListEntry[]): PluginListEntry[] {
  const seenNames = new Set<string>();
  const seenRoutes = new Set<string>();
  const acceptedNames = new Set<string>();
  const rejectedNames = new Set<string>();

  const accepted = entries.filter((entry) => {
    if (seenNames.has(entry.name)) {
      console.error(`[mndw] Skipping duplicate plugin "${entry.name}"`);
      rejectedNames.add(entry.name);

      return false;
    }

    seenNames.add(entry.name);

    if (entry.type === 'page') {
      if (seenRoutes.has(entry.route)) {
        console.error(`[mndw] Skipping duplicate page route "${entry.route}"`);
        rejectedNames.add(entry.name);

        return false;
      }

      seenRoutes.add(entry.route);
    }

    acceptedNames.add(entry.name);

    return true;
  });

  for (const name of rejectedNames) {
    if (!acceptedNames.has(name)) {
      setPluginLoadState(name, 'not-runnable');
    }
  }

  return accepted;
}

interface ResolvedLoaderDeps {
  importModule: (url: string) => Promise<unknown>;
  loadStylesheet: (href: string, pluginName: string) => Promise<void>;
  checkVersions: (entry: PluginListEntry, dir: string) => string[] | Promise<string[]>;
  catalogService: PluginCatalogService;
  registry: Pick<PluginRegistry, 'register' | 'clear' | 'get' | 'remove'>;
  retryPlugin: (name: string) => Promise<boolean>;
  getLocale: () => string;
  loadTimeoutMs: number;
}

interface ActiveLoaderRun {
  generation: number;
  authGeneration: number;
  authSignal: AbortSignal;
  deps: ResolvedLoaderDeps;
  entries: Map<string, PluginListEntry>;
  pluginTokens: Map<string, number>;
}

let activeLoaderRun: ActiveLoaderRun | undefined;
const retryPromises = new Map<string, Promise<boolean>>();

interface PluginLoadResult {
  loaded: boolean;
  failureKind?: PluginLoadFailureKind;
}

async function loadOne(
  entry: PluginListEntry,
  deps: ResolvedLoaderDeps,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<PluginLoadResult> {
  const base = entry.source === 'builtin' ? PLUGIN_SOURCE_PATHS.builtin : PLUGIN_SOURCE_PATHS.user;
  const dir = `${base}${entry.name}`;
  const assetUrl = (asset: string): string => versionedAssetUrl(dir, asset, entry.version);

  try {
    const source = createPluginCatalogSource(
      entry.name,
      entry.version,
      entry.catalogBaseUrl ?? dir,
      entry.i18n,
    );
    const catalog = source === undefined
      ? undefined
      : deps.catalogService.createPluginCatalogCell(source, deps.getLocale());
    setPluginLoadCatalog(entry.name, catalog);

    if (catalog !== undefined) {
      await deps.catalogService.loadInitialPluginCatalog(catalog, deps.getLocale());
    }

    if (!isCurrent() || signal.aborted) {
      return {loaded: false};
    }

    await deps.loadStylesheet(assetUrl('index.css'), entry.name);

    if (!isCurrent() || signal.aborted) {
      return {loaded: false};
    }

    const module = await deps.importModule(assetUrl(entry.entry));
    const pluginModule = validateModule(module, entry.name);

    // The load already timed out and was reported; registering now would surface a plugin the
    // rest of the startup has moved on without.
    if (signal.aborted || !isCurrent()) {
      return {loaded: false};
    }

    deps.registry.register({entry, module: pluginModule, ...(catalog === undefined ? {} : {catalog})});
    console.log(`[mndw] Loaded plugin: ${entry.name} (${entry.source})`);

    void Promise.resolve()
      .then(() => deps.checkVersions(entry, dir))
      .then((mismatches) => {
        if (isCurrent()) {
          setPluginVersionWarnings(entry.name, mismatches);
        }
      })
      .catch((err: unknown) => {
        console.error(`[mndw] Version check failed for "${entry.name}":`, err);
      });

    return {loaded: true};
  } catch (err) {
    console.error(`[mndw] Failed to load plugin "${entry.name}":`, err);

    return {loaded: false, failureKind: 'error'};
  }
}

async function loadOneWithTimeout(
  entry: PluginListEntry,
  deps: ResolvedLoaderDeps,
  isCurrent: () => boolean,
): Promise<PluginLoadResult> {
  const controller = new AbortController();
  const timedOut = new Promise<PluginLoadResult>((resolve) => {
    controller.signal.addEventListener('abort', () => {
      console.error(`[mndw] Plugin "${entry.name}" did not load within ${deps.loadTimeoutMs} ms; skipping it`);
      resolve({loaded: false, failureKind: 'timeout'});
    }, {once: true});
  });
  const timer = setTimeout(() => controller.abort(), deps.loadTimeoutMs);

  try {
    return await Promise.race([loadOne(entry, deps, controller.signal, isCurrent), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function isRunCurrent(run: ActiveLoaderRun): boolean {
  return run.generation === loadGeneration
    && run.authGeneration === getAuthRunGeneration()
    && !run.authSignal.aborted;
}

async function loadAndTrack(
  entry: PluginListEntry,
  run: ActiveLoaderRun,
  token = run.pluginTokens.get(entry.name) ?? 0,
): Promise<boolean> {
  setPluginLoadState(entry.name, 'loading');

  const isCurrent = (): boolean => isRunCurrent(run) && run.pluginTokens.get(entry.name) === token;
  const result = await loadOneWithTimeout(entry, run.deps, isCurrent);

  if (isCurrent()) {
    setPluginLoadState(entry.name, result.loaded ? 'loaded' : 'failed', result.failureKind);
  }

  return result.loaded;
}

/** Retries one runnable plugin using the latest successful list and its active loader dependencies. */
export async function retryPluginLoad(name: string): Promise<boolean> {
  const run = activeLoaderRun;
  const entry = run?.entries.get(name);
  const state = getPluginLoadState(name);

  if (run === undefined || entry === undefined || state?.runnable !== true || !isRunCurrent(run)) {
    return false;
  }

  const existing = retryPromises.get(name);

  if (existing !== undefined) {
    return existing;
  }

  const isCurrent = (): boolean => isRunCurrent(run);

  beginPluginLoadRetry(retryPluginLoad, isCurrent);

  const retry = loadAndTrack(entry, run).finally(() => {
    if (retryPromises.get(name) === retry) {
      retryPromises.delete(name);
    }

    if (isCurrent()) {
      finishPluginLoadRetry(retryPluginLoad, isCurrent);
    }
  });

  retryPromises.set(name, retry);

  return retry;
}

/** Reconciles a fresh daemon list against the live registry without restarting the host. */
export async function syncPlugins(entries: PluginListEntry[]): Promise<boolean> {
  const run = activeLoaderRun;

  if (run === undefined || !isRunCurrent(run)) {
    return false;
  }

  const previousStates = {...getPluginLoadStates()};
  const runnable = dedupe(entries.filter((entry) => entry.enabled && entry.approval === 'approved'));
  const nextEntries = new Map(runnable.map((entry) => [entry.name, entry]));
  let reloadRequired = false;

  replaceDepsStatuses(entries);
  applyPluginListSnapshot(entries, true);
  setPluginLoadListOutcome('ok');

  for (const name of run.entries.keys()) {
    if (nextEntries.has(name)) {
      continue;
    }

    run.pluginTokens.set(name, (run.pluginTokens.get(name) ?? 0) + 1);
    run.entries.delete(name);
    run.deps.registry.remove(name);
    setPluginVersionWarnings(name, []);
  }

  const loads: Promise<boolean>[] = [];

  for (const entry of runnable) {
    const name = entry.name;
    const previousEntry = run.entries.get(name);
    const previousState = previousStates[name];
    const loaded = run.deps.registry.get(name);
    const versionChanged = previousEntry !== undefined && previousEntry.version !== entry.version;

    run.entries.set(name, entry);

    if (loaded !== undefined) {
      setPluginLoadCatalog(name, loaded.catalog);

      if (loaded.entry.version !== entry.version) {
        reloadRequired = true;
      }

      setPluginLoadState(name, 'loaded');
      continue;
    }

    if (previousEntry === undefined || versionChanged) {
      const token = (run.pluginTokens.get(name) ?? 0) + 1;

      run.pluginTokens.set(name, token);
      loads.push(loadAndTrack(entry, run, token));
      continue;
    }

    if (previousState?.status === 'failed') {
      setPluginLoadState(name, 'failed', previousState.failureKind);
    } else if (previousState?.status === 'loading') {
      setPluginLoadState(name, 'loading');
    } else {
      setPluginLoadState(name, 'failed', 'error');
    }
  }

  await Promise.all(loads);

  if (isRunCurrent(run)) {
    appState.pluginLoadError = null;
    syncPluginLoadFailureToast(retryPluginLoad, () => isRunCurrent(run));
  }

  return reloadRequired;
}

/**
 * Loads the plugin list from the daemon (`GET /api/mgmt/list`), then imports and
 * registers every enabled plugin's module. The daemon already validated + merged
 * builtin/user plugins; name/route dedupe here is defense in depth. A single plugin
 * failing to import, or not loading within `loadTimeoutMs`, is logged and skipped — it
 * never aborts or stalls the rest.
 */
export async function loadPlugins(deps: LoaderDeps = {}): Promise<void> {
  activeListController?.abort();

  const generation = ++loadGeneration;
  const authGeneration = getAuthRunGeneration();
  const authSignal = getAuthRunSignal();
  const listController = new AbortController();

  activeListController = listController;

  const abortListForAuthRun = (): void => listController.abort(authSignal.reason);

  if (authSignal.aborted) {
    abortListForAuthRun();
  } else {
    authSignal.addEventListener('abort', abortListForAuthRun, {once: true});
  }

  const isCurrent = (): boolean => generation === loadGeneration && authGeneration === getAuthRunGeneration();
  const fetchList = deps.fetchList ?? defaultFetchList;
  const resolved: ResolvedLoaderDeps = {
    importModule: deps.importModule ?? ((url) => import(/* @vite-ignore */ url)),
    loadStylesheet: deps.loadStylesheet ?? ensurePluginStylesheet,
    checkVersions: deps.checkVersions ?? defaultCheckVersions,
    catalogService: deps.catalogService ?? pluginCatalogService,
    registry: deps.registry ?? pluginRegistry,
    retryPlugin: retryPluginLoad,
    getLocale: deps.getLocale ?? getLocale,
    loadTimeoutMs: deps.loadTimeoutMs ?? PLUGIN_LOAD_TIMEOUT_MS,
  };

  activeLoaderRun = undefined;
  retryPromises.clear();

  if (activePluginLoadToastAuthBinding !== undefined) {
    activePluginLoadToastAuthBinding.signal.removeEventListener(
      'abort',
      activePluginLoadToastAuthBinding.handler,
    );
    activePluginLoadToastAuthBinding = undefined;
  }

  const toastOwnerGeneration = resetPluginLoadFailureToast();
  const dismissToastOnAuthAbort = (): void => {
    if (activePluginLoadToastAuthBinding?.handler === dismissToastOnAuthAbort) {
      activePluginLoadToastAuthBinding = undefined;
    }

    dismissPluginLoadFailureToast(toastOwnerGeneration);
  };

  if (authSignal.aborted) {
    dismissToastOnAuthAbort();
  } else {
    activePluginLoadToastAuthBinding = {signal: authSignal, handler: dismissToastOnAuthAbort};
    authSignal.addEventListener('abort', dismissToastOnAuthAbort, {once: true});
  }

  setPluginLoadListOutcome('pending');
  replacePluginLoadStates([]);

  resolved.registry.clear();
  replaceDepsStatuses([]);
  clearPluginVersionWarnings();

  let entries: PluginListEntry[];

  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectAborted: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const rejectForAbort = (): void => {
      rejectAborted(
        listController.signal.reason
          ?? new DOMException('Plugin list request aborted', 'AbortError'),
      );
    };

    listController.signal.addEventListener('abort', rejectForAbort, {once: true});

    if (listController.signal.aborted) {
      rejectForAbort();
    }

    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => {
          reject(new Error(`Plugin list fetch timed out after ${MGMT_LIST_TIMEOUT_MS} ms`));
          listController.abort();
        },
        MGMT_LIST_TIMEOUT_MS,
      );
    });

    try {
      entries = await Promise.race([fetchList(listController.signal), deadline, aborted]);
    } finally {
      clearTimeout(timeout);
      listController.signal.removeEventListener('abort', rejectForAbort);
      authSignal.removeEventListener('abort', abortListForAuthRun);

      if (activeListController === listController) {
        activeListController = undefined;
      }
    }
  } catch (err) {
    if (isCurrent()) {
      if (!authSignal.aborted) {
        activeLoaderRun = {
          generation,
          authGeneration,
          authSignal,
          deps: resolved,
          entries: new Map(),
          pluginTokens: new Map(),
        };
      }

      console.error('[mndw] Failed to load plugin list:', err);
      appState.pluginLoadError = 'list';
      setPluginLoadListOutcome('failed');
    }

    return;
  }

  if (!isCurrent()) {
    return;
  }

  replaceDepsStatuses(entries);
  applyPluginListSnapshot(entries);
  setPluginLoadListOutcome('ok');

  // Only enabled+approved plugins are runnable and served on disk; pending/disabled
  // ones appear in the list (for the settings UI) but must not load into the runtime.
  const runnable = dedupe(entries.filter((entry) => entry.enabled && entry.approval === 'approved'));

  const run: ActiveLoaderRun = {
    generation,
    authGeneration,
    authSignal,
    deps: resolved,
    entries: new Map(runnable.map((entry) => [entry.name, entry])),
    pluginTokens: new Map(runnable.map((entry) => [entry.name, 0])),
  };

  activeLoaderRun = run;

  await Promise.all(
    runnable.map((entry) => loadAndTrack(entry, run, 0)),
  );

  if (isCurrent()) {
    appState.pluginLoadError = null;
    syncPluginLoadFailureToast(retryPluginLoad, isCurrent);
  }
}
