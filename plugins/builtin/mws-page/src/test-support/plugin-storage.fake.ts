import type {PluginStorage} from '@mndw/sdk';
import {vi} from 'vitest';

export interface FakePluginStorageOptions {
  mode?: 'immediate' | 'resolve-on-demand';
  values?: Record<string, string>;
}

interface PendingGet {
  key: string;
  resolve: (value: string | null) => void;
  reject: (reason?: unknown) => void;
}

export class FakePluginStorage implements PluginStorage {
  private readonly values = new Map<string, string>();
  private readonly mode: 'immediate' | 'resolve-on-demand';
  private readonly pendingGets: PendingGet[] = [];

  public readonly get = vi.fn((key: string): Promise<string | null> => {
    if (this.mode === 'resolve-on-demand') {
      return new Promise<string | null>((resolve, reject) => {
        this.pendingGets.push({key, resolve, reject});
      });
    }

    return Promise.resolve(this.values.get(key) ?? null);
  });

  public readonly set = vi.fn((key: string, value: string): Promise<void> => {
    this.values.set(key, value);

    return Promise.resolve();
  });

  public readonly delete = vi.fn((key: string): Promise<void> => {
    this.values.delete(key);

    return Promise.resolve();
  });

  public readonly keys = vi.fn((): Promise<string[]> => Promise.resolve([...this.values.keys()]));

  public constructor(options: FakePluginStorageOptions = {}) {
    this.mode = options.mode ?? 'immediate';

    for (const [key, value] of Object.entries(options.values ?? {})) {
      this.values.set(key, value);
    }
  }

  public read(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public resolveGet(value: string | null): void {
    const pending = this.pendingGets.shift();

    if (pending !== undefined) {
      pending.resolve(value);
    }
  }

  public rejectGet(reason: unknown = new Error('fake storage get failed')): void {
    this.pendingGets.shift()?.reject(reason);
  }
}
