import {PLUGIN_STORAGE_PREFIX} from '../constants.js';

const counters = new Map<string, number>();

function counterKey(pluginName: string): string {
  return `${PLUGIN_STORAGE_PREFIX}:${pluginName}:counter`;
}

function isCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function storedCounter(pluginName: string): number {
  try {
    const value = localStorage.getItem(counterKey(pluginName));

    if (value === null || value.trim() === '') {
      return 0;
    }

    const counter = Number(value);

    if (!isCounter(counter)) {
      return 0;
    }

    counters.set(pluginName, Math.max(counters.get(pluginName) ?? 0, counter));

    return counter;
  } catch (error) {
    console.error(`[mndw] Failed to read widget counter for "${pluginName}":`, error);

    return 0;
  }
}

function currentCounter(pluginName: string): number {
  return Math.max(storedCounter(pluginName), counters.get(pluginName) ?? 0);
}

function persistCounter(pluginName: string, counter: number): void {
  try {
    localStorage.setItem(counterKey(pluginName), String(counter));
  } catch (error) {
    console.error(`[mndw] Failed to write widget counter for "${pluginName}":`, error);
  }
}

export function getNextInstanceId(pluginName: string): string {
  const counter = currentCounter(pluginName);

  if (counter === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Widget instance counter exhausted for "${pluginName}"`);
  }

  const nextCounter = counter + 1;

  counters.set(pluginName, nextCounter);
  persistCounter(pluginName, nextCounter);

  return `${pluginName}:${nextCounter}`;
}

export function raiseInstanceCounter(pluginName: string, restoredCounter: number): void {
  if (!isCounter(restoredCounter)) {
    console.error(`[mndw] Ignoring invalid restored widget counter for "${pluginName}":`, restoredCounter);

    return;
  }

  if (restoredCounter > currentCounter(pluginName)) {
    counters.set(pluginName, restoredCounter);
    persistCounter(pluginName, restoredCounter);
  }
}
