import {Injectable, type Signal, inject, signal} from '@angular/core';
import type {PluginStorage} from '@mndw/sdk';
import {DEFAULT_RSSI_THRESHOLDS, type RssiThresholds} from '../components/mws-graph/link-quality';
import {SHARED_PLUGIN_STORAGE} from '../tokens';

export const RSSI_THRESHOLDS_KEY = 'mws-rssi-thresholds';
export const RSSI_THRESHOLD_MIN = -100;
export const RSSI_THRESHOLD_MAX = -20;

const STORAGE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inRange(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= RSSI_THRESHOLD_MIN
    && value <= RSSI_THRESHOLD_MAX;
}

export function isValidRssiThresholds(value: RssiThresholds): boolean {
  return inRange(value.good) && inRange(value.fair) && value.good > value.fair;
}

function defaults(): RssiThresholds {
  return {...DEFAULT_RSSI_THRESHOLDS};
}

@Injectable()
export class RssiThresholdsStore {
  private readonly storage = inject<PluginStorage>(SHARED_PLUGIN_STORAGE);
  private readonly thresholdsSignal = signal<RssiThresholds>(defaults());
  private loadPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private generation = 0;

  public readonly thresholds: Signal<RssiThresholds> = this.thresholdsSignal.asReadonly();

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

  public setThresholds(thresholds: RssiThresholds): void {
    if (!isValidRssiThresholds(thresholds)) {
      return;
    }

    this.generation += 1;

    const next: RssiThresholds = {good: thresholds.good, fair: thresholds.fair};

    this.thresholdsSignal.set(next);

    const envelope = JSON.stringify({version: STORAGE_VERSION, thresholds: next});

    this.writeChain = this.writeChain
      .then(() => this.storage.set(RSSI_THRESHOLDS_KEY, envelope))
      .catch(() => undefined);
  }

  public flush(): Promise<void> {
    return this.writeChain;
  }

  private async read(loadGeneration: number): Promise<void> {
    let raw: string | null = null;

    try {
      raw = await this.storage.get(RSSI_THRESHOLDS_KEY);
    } catch {
      return;
    }

    const parsed = this.parse(raw);

    if (loadGeneration === this.generation) {
      this.thresholdsSignal.set(parsed);
    }
  }

  private parse(raw: string | null): RssiThresholds {
    if (raw === null) {
      return defaults();
    }

    try {
      const value: unknown = JSON.parse(raw);

      if (!isRecord(value) || value.version !== STORAGE_VERSION || !isRecord(value.thresholds)) {
        return defaults();
      }

      const good = value.thresholds.good;
      const fair = value.thresholds.fair;

      if (!inRange(good) || !inRange(fair) || good <= fair) {
        return defaults();
      }

      return {good, fair};
    } catch {
      return defaults();
    }
  }
}
