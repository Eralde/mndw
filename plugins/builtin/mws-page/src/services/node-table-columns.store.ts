import {Injectable, type Signal, inject, signal} from '@angular/core';
import type {PluginStorage} from '@mndw/sdk';
import {SHARED_PLUGIN_STORAGE} from '../tokens';

export const NODE_TABLE_COLUMNS_KEY = 'mws-node-table-columns';
export const OPTIONAL_NODE_COLUMN_IDS = [
  'clients',
  'status',
  'uptime',
  'ip',
  'via',
  'connection',
  'firmware',
] as const;

export type OptionalNodeColumnId = typeof OPTIONAL_NODE_COLUMN_IDS[number];

const STORAGE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalNodeColumnId(value: unknown): value is OptionalNodeColumnId {
  return typeof value === 'string'
    && (OPTIONAL_NODE_COLUMN_IDS as readonly string[]).includes(value);
}

function defaultColumns(): Set<OptionalNodeColumnId> {
  return new Set(OPTIONAL_NODE_COLUMN_IDS);
}

@Injectable()
export class NodeTableColumnsStore {
  private readonly storage = inject<PluginStorage>(SHARED_PLUGIN_STORAGE);
  private readonly visibleColumnsSignal = signal<ReadonlySet<OptionalNodeColumnId>>(defaultColumns());
  private loadPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private generation = 0;

  public readonly visibleColumns: Signal<ReadonlySet<OptionalNodeColumnId>> = this.visibleColumnsSignal.asReadonly();

  public load(): Promise<void> {
    if (this.loadPromise !== null) {
      return this.loadPromise;
    }

    const loadGeneration = this.generation;

    this.loadPromise = this.read(loadGeneration).finally(() => {
      this.loadPromise = null;
    });

    return this.loadPromise;
  }

  public setVisible(id: OptionalNodeColumnId, visible: boolean): void {
    this.generation += 1;

    const next = new Set(this.visibleColumnsSignal());

    if (visible) {
      next.add(id);
    } else {
      next.delete(id);
    }

    this.visibleColumnsSignal.set(next);

    const envelope = JSON.stringify({version: STORAGE_VERSION, columns: [...next]});

    this.writeChain = this.writeChain
      .then(() => this.storage.set(NODE_TABLE_COLUMNS_KEY, envelope))
      .catch(() => undefined);
  }

  public flush(): Promise<void> {
    return this.writeChain;
  }

  private async read(loadGeneration: number): Promise<void> {
    let raw: string | null = null;

    try {
      raw = await this.storage.get(NODE_TABLE_COLUMNS_KEY);
    } catch {
      return;
    }

    const parsed = this.parse(raw);

    if (loadGeneration === this.generation) {
      this.visibleColumnsSignal.set(parsed);
    }
  }

  private parse(raw: string | null): Set<OptionalNodeColumnId> {
    if (raw === null) {
      return defaultColumns();
    }

    try {
      const value: unknown = JSON.parse(raw);

      if (!isRecord(value) || value.version !== STORAGE_VERSION || !Array.isArray(value.columns)) {
        return defaultColumns();
      }

      return new Set(value.columns.filter(isOptionalNodeColumnId));
    } catch {
      return defaultColumns();
    }
  }
}
