import {Injectable, type Signal, inject, signal} from '@angular/core';
import type {PluginStorage} from '@mndw/sdk';
import {PLUGIN_STORAGE} from '../tokens';

export const NODE_POSITIONS_KEY = 'node-positions';
export const MAX_STORED_POSITIONS = 200;
const STORAGE_VERSION = 1;
const WRITE_DEBOUNCE_MS = 500;

export type PositionsLoadOutcome = 'pending' | 'applied' | 'none';

interface Position {
  x: number;
  y: number;
}

interface StoredPosition extends Position {
  updatedAt: number;
}

interface StoredEnvelope {
  version: number;
  positions: Record<string, StoredPosition>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredPosition(value: unknown): value is StoredPosition {
  return isRecord(value)
    && typeof value.x === 'number'
    && Number.isFinite(value.x)
    && typeof value.y === 'number'
    && Number.isFinite(value.y)
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt);
}

function copyPosition(position: Position): Position {
  return {x: position.x, y: position.y};
}

function capEntries(entries: Map<string, StoredPosition>): Map<string, StoredPosition> {
  if (entries.size <= MAX_STORED_POSITIONS) {
    return entries;
  }

  return new Map(
    [...entries.entries()]
      .sort(([, first], [, second]) => second.updatedAt - first.updatedAt)
      .slice(0, MAX_STORED_POSITIONS),
  );
}

@Injectable()
export class NodePositionStore {
  private readonly storage = inject<PluginStorage>(PLUGIN_STORAGE);
  private readonly entries = new Map<string, StoredPosition>();
  private readonly positionsSignal = signal<ReadonlyMap<string, Position>>(new Map());
  private readonly loadOutcomeSignal = signal<PositionsLoadOutcome>('pending');
  private loadPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private dirty = false;
  private writeQueued = false;

  public readonly positions: Signal<ReadonlyMap<string, Position>> = this.positionsSignal.asReadonly();
  public readonly loadOutcome: Signal<PositionsLoadOutcome> = this.loadOutcomeSignal.asReadonly();
  public readonly persistDegraded = signal(false);

  public load(): Promise<void> {
    if (this.loadOutcomeSignal() !== 'pending') {
      return Promise.resolve();
    }

    if (this.loadPromise !== null) {
      return this.loadPromise;
    }

    const loadGeneration = this.generation;

    this.loadPromise = this.readPositions(loadGeneration).finally(() => {
      this.loadPromise = null;
    });

    return this.loadPromise;
  }

  public get(id: string): Position | undefined {
    const position = this.entries.get(id);

    return position === undefined ? undefined : copyPosition(position);
  }

  public set(id: string, position: Position): void {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      return;
    }

    this.generation += 1;
    this.entries.set(id, {x: position.x, y: position.y, updatedAt: Date.now()});
    this.replaceEntries(capEntries(this.entries));
    this.publish();
    this.dirty = true;
    this.persistDegraded.set(false);
    this.scheduleWrite();
  }

  public clear(): Promise<void> {
    this.generation += 1;
    this.entries.clear();
    this.publish();
    this.dirty = true;
    this.persistDegraded.set(false);

    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }

    return this.drainWrites();
  }

  public flush(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }

    return this.drainWrites();
  }

  private async readPositions(loadGeneration: number): Promise<void> {
    let raw: string | null = null;

    try {
      raw = await this.storage.get(NODE_POSITIONS_KEY);
    } catch {
      this.publish();
      this.finishLoad('none');

      return;
    }

    const loaded = this.parse(raw);

    if (loadGeneration === this.generation && loaded.size > 0) {
      this.replaceEntries(loaded);
      this.publish();
      this.finishLoad('applied');

      return;
    }

    this.publish();
    this.finishLoad('none');
  }

  private parse(raw: string | null): Map<string, StoredPosition> {
    if (raw === null) {
      return new Map();
    }

    try {
      const parsed: unknown = JSON.parse(raw);

      if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isRecord(parsed.positions)) {
        return new Map();
      }

      const entries = new Map<string, StoredPosition>();

      for (const [id, value] of Object.entries(parsed.positions)) {
        if (isStoredPosition(value)) {
          entries.set(id, value);
        }
      }

      return capEntries(entries);
    } catch {
      return new Map();
    }
  }

  private replaceEntries(entries: Map<string, StoredPosition>): void {
    const next = [...entries.entries()];

    this.entries.clear();

    for (const [id, position] of next) {
      this.entries.set(id, {...position});
    }
  }

  private publish(): void {
    const next = new Map<string, Position>();

    for (const [id, position] of this.entries) {
      next.set(id, copyPosition(position));
    }

    this.positionsSignal.set(next);
  }

  private finishLoad(outcome: Exclude<PositionsLoadOutcome, 'pending'>): void {
    if (this.loadOutcomeSignal() === 'pending') {
      this.loadOutcomeSignal.set(outcome);
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
    }

    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.enqueueWrite();
    }, WRITE_DEBOUNCE_MS);
  }

  private enqueueWrite(): void {
    if (this.persistDegraded() || this.writeQueued) {
      return;
    }

    this.writeQueued = true;
    this.writeChain = this.writeChain.then(async () => {
      const writeGeneration = this.generation;

      await this.persistWithRetry();

      if (writeGeneration === this.generation) {
        this.dirty = false;
      }
    }).catch(() => undefined)
      .finally(() => {
        this.writeQueued = false;

        if (this.dirty && this.writeTimer === null && !this.persistDegraded()) {
          queueMicrotask(() => this.enqueueWrite());
        }
      });
  }

  private async drainWrites(): Promise<void> {
    while (this.dirty && !this.persistDegraded()) {
      if (!this.writeQueued) {
        this.enqueueWrite();
      }

      await this.writeChain;
    }
  }

  private async persistWithRetry(): Promise<void> {
    try {
      await this.persist();

      return;
    } catch {
      try {
        await this.persist();
      } catch {
        this.persistDegraded.set(true);
      }
    }
  }

  private async persist(): Promise<void> {
    if (this.entries.size === 0) {
      await this.storage.delete(NODE_POSITIONS_KEY);

      return;
    }

    const entries = capEntries(new Map(this.entries));
    const positions: Record<string, StoredPosition> = {};

    for (const [id, position] of entries) {
      positions[id] = {...position};
    }

    const envelope: StoredEnvelope = {version: STORAGE_VERSION, positions};

    await this.storage.set(NODE_POSITIONS_KEY, JSON.stringify(envelope));
  }
}
