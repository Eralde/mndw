import type {PluginRegistry} from './plugin-registry.js';
import {getPluginLoadStates} from './plugin-load-state.svelte.js';

export interface PagePluginCandidate {
  readonly name: string;
  readonly label: string;
  readonly route: string;
  readonly status: 'loaded' | 'failed' | 'loading';
}

/** Collects registered pages and runnable page loads that still need a route. */
export function getPagePluginCandidates(
  registry: Pick<PluginRegistry, 'getPages'>,
): PagePluginCandidate[] {
  const loadedPages = registry.getPages().map((page) => ({
    name: page.entry.name,
    label: page.entry.label,
    route: page.entry.route,
    status: 'loaded' as const,
  }));
  const registeredNames = new Set(loadedPages.map(({name}) => name));
  const pendingPages = Object.entries(getPluginLoadStates()).flatMap(([name, state]) => {
    if (
      !state.runnable
      || (state.status !== 'failed' && state.status !== 'loading')
      || state.type !== 'page'
      || state.route === undefined
      || registeredNames.has(name)
    ) {
      return [];
    }

    return [{name, label: state.label, route: state.route, status: state.status}];
  });

  return [...loadedPages, ...pendingPages]
    .sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
}
