import type {PluginListEntry} from './plugin-types.js';
import type {WidgetSize} from '../dashboard/widget-size.js';
import type {PluginCatalogCell} from '../services/plugin-catalog.service.js';

export type PluginLoadListOutcome = 'pending' | 'ok' | 'failed';
export type PluginLoadStatus = 'loaded' | 'failed' | 'loading' | 'not-runnable';
export type PluginLoadFailureKind = 'timeout' | 'error';

export interface PluginLoadState {
  runnable: boolean;
  status: PluginLoadStatus;
  type: PluginListEntry['type'];
  version: string;
  label: string;
  description?: string;
  catalog?: PluginCatalogCell;
  size?: WidgetSize;
  route?: string;
  failureKind?: PluginLoadFailureKind;
}

const pluginLoadStates = $state<Record<string, PluginLoadState>>({});
let listOutcome = $state<PluginLoadListOutcome>('pending');
let pluginListRevision = $state(0);

export function getPluginListRevision(): number {
  return pluginListRevision;
}

export function getPluginLoadListOutcome(): PluginLoadListOutcome {
  return listOutcome;
}

export function setPluginLoadListOutcome(outcome: PluginLoadListOutcome): void {
  listOutcome = outcome;
}

export function replacePluginLoadStates(entries: PluginListEntry[], preserveCatalogs = false): void {
  const previousStates = {...pluginLoadStates};

  for (const name of Object.keys(pluginLoadStates)) {
    delete pluginLoadStates[name];
  }

  for (const entry of entries) {
    const runnable = entry.enabled && entry.approval === 'approved';
    pluginLoadStates[entry.name] = {
      runnable,
      status: runnable ? 'loading' : 'not-runnable',
      type: entry.type,
      version: entry.version,
      label: entry.label,
      ...(entry.description === undefined ? {} : {description: entry.description}),
      ...(preserveCatalogs && previousStates[entry.name]?.version === entry.version
          && previousStates[entry.name].catalog !== undefined
        ? {catalog: previousStates[entry.name].catalog}
        : {}),
      ...(entry.type === 'widget' ? {size: entry.size} : {}),
      ...(entry.type === 'page' ? {route: entry.route} : {}),
    };
  }
}

export function applyPluginListSnapshot(entries: PluginListEntry[], preserveCatalogs = false): void {
  replacePluginLoadStates(entries, preserveCatalogs);
  pluginListRevision += 1;
}

export function setPluginLoadState(
  name: string,
  status: PluginLoadStatus,
  failureKind?: PluginLoadFailureKind,
): void {
  const current = pluginLoadStates[name];

  if (current !== undefined) {
    const {failureKind: _previousFailureKind, ...rest} = current;
    pluginLoadStates[name] = {
      ...rest,
      ...(status === 'not-runnable' ? {runnable: false} : {}),
      status,
      ...(status === 'failed' && failureKind !== undefined ? {failureKind} : {}),
    };
  }
}

export function setPluginLoadCatalog(name: string, catalog: PluginCatalogCell | undefined): void {
  const current = pluginLoadStates[name];

  if (current !== undefined) {
    const {catalog: _previousCatalog, ...rest} = current;
    pluginLoadStates[name] = {
      ...rest,
      ...(catalog === undefined ? {} : {catalog}),
    };
  }
}

export function getPluginLoadState(name: string): PluginLoadState | undefined {
  return pluginLoadStates[name];
}

export function getPluginLoadStates(): Readonly<Record<string, PluginLoadState>> {
  return pluginLoadStates;
}
