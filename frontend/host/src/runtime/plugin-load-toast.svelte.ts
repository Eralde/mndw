import {hostT} from '../services/host-i18n.svelte.js';
import {getPluginManifestPresentation} from '../services/plugin-catalog.service.js';
import {toast} from '../services/toast/toast.svelte.js';
import {appState} from '../state/app.svelte.js';
import {getPluginLoadStates} from './plugin-load-state.svelte.js';

type RetryPlugin = (name: string) => Promise<boolean>;
type IsCurrent = () => boolean;

const PLUGIN_LOAD_TOAST_KEY = 'plugin-load';

let toastOwnerGeneration = 0;
let activeRetryCount = 0;
let batchRetrying = false;
let retryOccurred = false;

function isRetryBusy(): boolean {
  return batchRetrying || activeRetryCount > 0;
}

function failedPlugins(): {name: string; label: string}[] {
  return Object.entries(getPluginLoadStates())
    .filter(([, state]) => state.runnable && state.status === 'failed')
    .map(([name, state]) => ({
      name,
      label: getPluginManifestPresentation(state, state.catalog, appState.locale).label,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
}

function failureMessage(names: string[]): string {
  const states = getPluginLoadStates();
  const labels = names.map((name) => {
    const state = states[name];

    return {
      name,
      label: state === undefined
        ? name
        : getPluginManifestPresentation(state, state.catalog, appState.locale).label,
    };
  });
  const displayNames = labels
    .sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name))
    .map(({label}) => label)
    .join(', ');

  return hostT('plugin-load.failed', {names: displayNames});
}

function showFailureToast(message: () => string, retryPlugin: RetryPlugin, isCurrent: IsCurrent): void {
  toast.error(message(), {
    key: PLUGIN_LOAD_TOAST_KEY,
    getMessage: message,
    action: {
      label: hostT('common.retry'),
      getLabel: () => hostT('common.retry'),
      busy: isRetryBusy(),
      onAction: () => retryFailedPlugins(retryPlugin, isCurrent),
    },
  });
}

async function retryFailedPlugins(retryPlugin: RetryPlugin, isCurrent: IsCurrent): Promise<void> {
  if (!isCurrent() || batchRetrying) {
    return;
  }

  batchRetrying = true;
  retryOccurred = true;
  syncPluginLoadFailureToast(retryPlugin, isCurrent);

  const names = failedPlugins().map(({name}) => name);

  await Promise.all(names.map(async (name) => {
    try {
      await retryPlugin(name);
    } catch (error) {
      console.error(`[mndw] Plugin retry failed for "${name}":`, error);
    }
  }));

  if (!isCurrent()) {
    return;
  }

  batchRetrying = false;
  syncPluginLoadFailureToast(retryPlugin, isCurrent);
}

export function syncPluginLoadFailureToast(retryPlugin: RetryPlugin, isCurrent: IsCurrent): void {
  if (!isCurrent()) {
    return;
  }

  const failed = failedPlugins();

  if (failed.length > 0) {
    const failedNames = failed.map(({name}) => name);
    showFailureToast(() => failureMessage(failedNames), retryPlugin, isCurrent);

    return;
  }

  if (isRetryBusy()) {
    const current = toast.toasts.find(({key}) => key === PLUGIN_LOAD_TOAST_KEY);

    if (current !== undefined) {
      showFailureToast(() => current.message, retryPlugin, isCurrent);
    }

    return;
  }

  if (retryOccurred) {
    toast.success(hostT('plugin-load.loaded'), {
      key: PLUGIN_LOAD_TOAST_KEY,
      duration: 4000,
    });
    retryOccurred = false;

    return;
  }

  toast.dismissKey(PLUGIN_LOAD_TOAST_KEY);
}

/** Starts retry tracking for manual page retries as well as the toast's batch action. */
export function beginPluginLoadRetry(retryPlugin: RetryPlugin, isCurrent: IsCurrent): void {
  activeRetryCount += 1;
  retryOccurred = true;
  syncPluginLoadFailureToast(retryPlugin, isCurrent);
}

/** Ends one retry after its load state has been updated. */
export function finishPluginLoadRetry(retryPlugin: RetryPlugin, isCurrent: IsCurrent): void {
  activeRetryCount = Math.max(0, activeRetryCount - 1);
  syncPluginLoadFailureToast(retryPlugin, isCurrent);
}

/** Clears prior notification state and returns ownership token for the next load run. */
export function resetPluginLoadFailureToast(): number {
  toastOwnerGeneration += 1;
  activeRetryCount = 0;
  batchRetrying = false;
  retryOccurred = false;
  toast.dismissKey(PLUGIN_LOAD_TOAST_KEY);

  return toastOwnerGeneration;
}

/** Dismisses a run's notification only while that run still owns the keyed toast. */
export function dismissPluginLoadFailureToast(ownerGeneration: number): void {
  if (ownerGeneration !== toastOwnerGeneration) {
    return;
  }

  activeRetryCount = 0;
  batchRetrying = false;
  retryOccurred = false;
  toast.dismissKey(PLUGIN_LOAD_TOAST_KEY);
}
