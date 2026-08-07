import type {MndwPlugin} from '@mndw/sdk';
import {MGMT_LIST_URL, PLUGIN_SOURCE_PATHS} from '../constants.js';
import {appState} from '../state/app.svelte.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {checkPluginVersions, readPluginLock} from './plugin-lock.js';
import {pluginRegistry} from './plugin-registry.js';
import type {PluginListEntry} from './plugin-types.js';
import {clearPluginVersionWarnings, setPluginVersionWarnings} from './plugin-version-warnings.svelte.js';

/**
 * Injectable dependencies so the loader is unit-testable without real HTTP or DOM. In
 * production the defaults fetch the daemon list, dynamic-import the plugin module, and
 * inject the per-plugin stylesheet.
 */
export interface LoaderDeps {
  fetchList?: () => Promise<PluginListEntry[]>;
  importModule?: (url: string) => Promise<unknown>;
  loadStylesheet?: (href: string, pluginName: string) => Promise<void>;
  checkVersions?: (entry: PluginListEntry, dir: string) => string[] | Promise<string[]>;
}

const loadedPluginStylesheets = new Set<string>();

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

async function defaultFetchList(): Promise<PluginListEntry[]> {
  const response = await fetch(MGMT_LIST_URL);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json() as {plugins?: unknown};

  return Array.isArray(data.plugins) ? data.plugins as PluginListEntry[] : [];
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

  return entries.filter((entry) => {
    if (seenNames.has(entry.name)) {
      console.error(`[mndw] Skipping duplicate plugin "${entry.name}"`);

      return false;
    }

    seenNames.add(entry.name);

    if (entry.type === 'page') {
      if (seenRoutes.has(entry.route)) {
        console.error(`[mndw] Skipping duplicate page route "${entry.route}"`);

        return false;
      }

      seenRoutes.add(entry.route);
    }

    return true;
  });
}

async function loadOne(
  entry: PluginListEntry,
  importModule: (url: string) => Promise<unknown>,
  loadStylesheet: (href: string, pluginName: string) => Promise<void>,
  checkVersions: (entry: PluginListEntry, dir: string) => string[] | Promise<string[]>,
): Promise<void> {
  const base = entry.source === 'builtin' ? PLUGIN_SOURCE_PATHS.builtin : PLUGIN_SOURCE_PATHS.user;
  const dir = `${base}${entry.name}`;

  await loadStylesheet(`${dir}/index.css`, entry.name);

  try {
    const module = await importModule(`${dir}/${entry.entry}`);

    pluginRegistry.register({entry, module: validateModule(module, entry.name)});
    console.log(`[mndw] Loaded plugin: ${entry.name} (${entry.source})`);

    void Promise.resolve()
      .then(() => checkVersions(entry, dir))
      .then((mismatches) => {
        setPluginVersionWarnings(entry.name, mismatches);
      })
      .catch((err: unknown) => {
        console.error(`[mndw] Version check failed for "${entry.name}":`, err);
      });
  } catch (err) {
    console.error(`[mndw] Failed to load plugin "${entry.name}":`, err);
  }
}

/**
 * Loads the plugin list from the daemon (`GET /api/mgmt/list`), then imports and
 * registers every enabled plugin's module. The daemon already validated + merged
 * builtin/user plugins; name/route dedupe here is defense in depth. A single plugin
 * failing to import is logged and skipped — it never aborts the rest.
 */
export async function loadPlugins(deps: LoaderDeps = {}): Promise<void> {
  const fetchList = deps.fetchList ?? defaultFetchList;
  const importModule = deps.importModule ?? ((url) => import(/* @vite-ignore */ url));
  const loadStylesheet = deps.loadStylesheet ?? ensurePluginStylesheet;
  const checkVersions = deps.checkVersions ?? defaultCheckVersions;

  pluginRegistry.clear();
  replaceDepsStatuses([]);
  appState.pluginLoadError = null;
  clearPluginVersionWarnings();

  let entries: PluginListEntry[];

  try {
    entries = await fetchList();
  } catch (err) {
    console.error('[mndw] Failed to load plugin list:', err);
    appState.pluginLoadError = 'Failed to load plugins. Check the console for details.';

    return;
  }

  replaceDepsStatuses(entries);

  // Only enabled+approved plugins are runnable and served on disk; pending/disabled
  // ones appear in the list (for the settings UI) but must not load into the runtime.
  const runnable = dedupe(entries.filter((entry) => entry.enabled));

  await Promise.all(runnable.map((entry) => loadOne(entry, importModule, loadStylesheet, checkVersions)));
}
