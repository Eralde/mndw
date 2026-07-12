import type {PluginStorage} from '@mndw/sdk';
import {PLUGIN_STORAGE_PREFIX} from '../constants.js';

export class ScopedPluginStorage implements PluginStorage {
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  public async get(key: string): Promise<string | null> {
    return Promise.resolve(localStorage.getItem(this.prefix + key));
  }

  public async set(key: string, value: string): Promise<void> {
    localStorage.setItem(this.prefix + key, value);

    return Promise.resolve();
  }

  public async delete(key: string): Promise<void> {
    localStorage.removeItem(this.prefix + key);

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
}

export function clearInstanceStorage(pluginName: string, instanceId: string): void {
  const prefix = `${PLUGIN_STORAGE_PREFIX}:${pluginName}:instance:${instanceId}:`;
  const toRemove: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);

    if (k?.startsWith(prefix)) {
      toRemove.push(k);
    }
  }

  for (const k of toRemove) {
    localStorage.removeItem(k);
  }
}
