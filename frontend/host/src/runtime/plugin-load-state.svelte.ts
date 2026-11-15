import type {PluginListEntry} from './plugin-types.js';
import type {WidgetSize} from '../dashboard/widget-size.js';

export type PluginLoadListOutcome = 'pending' | 'ok' | 'failed';
export type PluginLoadStatus = 'loaded' | 'failed' | 'loading' | 'not-runnable';

export interface PluginLoadState {
  runnable: boolean;
  status: PluginLoadStatus;
  type: PluginListEntry['type'];
  label: string;
  size?: WidgetSize;
}

const pluginLoadStates = $state<Record<string, PluginLoadState>>({});
let listOutcome = $state<PluginLoadListOutcome>('pending');

export function getPluginLoadListOutcome(): PluginLoadListOutcome {
  return listOutcome;
}

export function setPluginLoadListOutcome(outcome: PluginLoadListOutcome): void {
  listOutcome = outcome;
}

export function replacePluginLoadStates(entries: PluginListEntry[]): void {
  for (const name of Object.keys(pluginLoadStates)) {
    delete pluginLoadStates[name];
  }

  for (const entry of entries) {
    const runnable = entry.enabled && entry.approval === 'approved';
    pluginLoadStates[entry.name] = {
      runnable,
      status: runnable ? 'loading' : 'not-runnable',
      type: entry.type,
      label: entry.label,
      ...(entry.type === 'widget' ? {size: entry.size} : {}),
    };
  }
}

export function setPluginLoadState(name: string, status: PluginLoadStatus): void {
  const current = pluginLoadStates[name];

  if (current !== undefined) {
    pluginLoadStates[name] = {...current, status};
  }
}

export function getPluginLoadState(name: string): PluginLoadState | undefined {
  return pluginLoadStates[name];
}

export function getPluginLoadStates(): Readonly<Record<string, PluginLoadState>> {
  return pluginLoadStates;
}
