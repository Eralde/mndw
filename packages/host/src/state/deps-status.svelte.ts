import {SvelteMap} from 'svelte/reactivity';
import {MGMT_LIST_URL} from '../constants.js';
import type {DepsStatus} from '../runtime/plugin-types.js';

/** Reactive plugin-name → depsStatus map. Absence means ready. */
export const depsStatusMap = new SvelteMap<string, DepsStatus>();

export function getDepsStatus(name: string): DepsStatus {
  return depsStatusMap.get(name) ?? 'ready';
}

/** Replaces map contents wholesale; each daemon response is authoritative. */
export function replaceDepsStatuses(
  entries: ReadonlyArray<{name: string; depsStatus: DepsStatus}>,
): void {
  depsStatusMap.clear();

  for (const entry of entries) {
    depsStatusMap.set(entry.name, entry.depsStatus);
  }
}

export function anyInstalling(): boolean {
  for (const status of depsStatusMap.values()) {
    if (status === 'installing') {
      return true;
    }
  }

  return false;
}

export const POLL_INTERVAL_MS = 3000;

type FetchStatuses = (signal: AbortSignal) => Promise<Array<{name: string; depsStatus: DepsStatus}>>;

export interface DepsPollingDeps {
  fetchList?: FetchStatuses;
}

let generation = 0;
let controller: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

async function defaultFetchStatuses(signal: AbortSignal): Promise<Array<{name: string; depsStatus: DepsStatus}>> {
  const response = await fetch(MGMT_LIST_URL, {signal});

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json() as {plugins?: unknown};

  return Array.isArray(data.plugins)
    ? data.plugins as Array<{name: string; depsStatus: DepsStatus}>
    : [];
}

/**
 * Starts a single-flight poll loop. Each response replaces status contents wholesale;
 * polling ends once no plugin reports installing.
 */
export function startDepsPolling(deps: DepsPollingDeps = {}): void {
  stopDepsPolling();
  generation += 1;
  controller = new AbortController();

  const gen = generation;
  const signal = controller.signal;
  const fetchList = deps.fetchList ?? defaultFetchStatuses;

  const scheduleNext = (): void => {
    timer = setTimeout(() => {
      void poll();
    }, POLL_INTERVAL_MS);
  };

  const poll = async (): Promise<void> => {
    let entries: Array<{name: string; depsStatus: DepsStatus}> | null = null;

    try {
      entries = await fetchList(signal);
    } catch (err) {
      console.error('[mndw] deps-status poll failed:', err);
    }

    if (gen !== generation) {
      return;
    }

    if (entries !== null) {
      replaceDepsStatuses(entries);
    }

    if (anyInstalling()) {
      scheduleNext();
    }
  };

  scheduleNext();
}

/** Stops polling and invalidates any in-flight response. */
export function stopDepsPolling(): void {
  clearTimeout(timer);
  timer = undefined;
  controller?.abort();
  controller = null;
  generation += 1;
}
