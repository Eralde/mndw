import type {PluginStorage} from '@mndw/sdk';
import {PLUGIN_STORAGE_PREFIX} from '../constants.js';

const instanceStorageRevisions = new Map<string, symbol>();

function isInstanceStoragePrefix(prefix: string): boolean {
  return prefix.includes(':instance:');
}

function currentRevision(prefix: string): symbol | undefined {
  return instanceStorageRevisions.get(prefix);
}

function claimRevision(prefix: string): symbol {
  const revision = Symbol();

  instanceStorageRevisions.set(prefix, revision);

  return revision;
}

function clearPrefix(prefix: string): void {
  const toRemove: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);

    if (key?.startsWith(prefix)) {
      toRemove.push(key);
    }
  }

  for (const key of toRemove) {
    localStorage.removeItem(key);
  }
}

export class ScopedPluginStorage implements PluginStorage {
  private readonly prefix: string;
  private readonly instanceRevision: symbol | null;

  constructor(prefix: string) {
    this.prefix = prefix;
    this.instanceRevision = isInstanceStoragePrefix(prefix)
      ? claimRevision(prefix)
      : null;
  }

  public async get(key: string): Promise<string | null> {
    return Promise.resolve(localStorage.getItem(this.prefix + key));
  }

  public async set(key: string, value: string): Promise<void> {
    if (this.canWrite()) {
      localStorage.setItem(this.prefix + key, value);
    }

    return Promise.resolve();
  }

  public async delete(key: string): Promise<void> {
    if (this.canWrite()) {
      localStorage.removeItem(this.prefix + key);
    }

    return Promise.resolve();
  }

  public async keys(): Promise<string[]> {
    const result: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);

      if (k?.startsWith(this.prefix)) {
        result.push(k.slice(this.prefix.length));
      }
    }

    return Promise.resolve(result);
  }

  private canWrite(): boolean {
    return this.instanceRevision === null
      || currentRevision(this.prefix) === this.instanceRevision;
  }
}

export function clearInstanceStorage(pluginName: string, instanceId: string): void {
  const prefix = `${PLUGIN_STORAGE_PREFIX}:${pluginName}:instance:${instanceId}:`;

  clearPrefix(prefix);
}

export function getInstanceStorageRevision(
  pluginName: string,
  instanceId: string,
): symbol | undefined {
  return currentRevision(`${PLUGIN_STORAGE_PREFIX}:${pluginName}:instance:${instanceId}:`);
}

export function finalizeInstanceStorageRemoval(
  pluginName: string,
  instanceId: string,
  expectedRevision: symbol | undefined,
): void {
  const prefix = `${PLUGIN_STORAGE_PREFIX}:${pluginName}:instance:${instanceId}:`;

  if (currentRevision(prefix) !== expectedRevision) {
    return;
  }

  clearPrefix(prefix);
  instanceStorageRevisions.delete(prefix);
}
