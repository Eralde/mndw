export interface RowMeasurement {
  summary?: number;
  detail?: number;
}

export interface VirtualizerInput {
  keys: readonly string[];
  expandedKeys: ReadonlySet<string>;
  measurements: ReadonlyMap<string, RowMeasurement>;
  estimatedRowHeight: number;
  detailEstimate: number;
  scrollOffset: number;
  viewportHeight: number;
  overscan: number;
}

export interface VirtualRange {
  start: number;
  end: number;
  paddingBefore: number;
  paddingAfter: number;
  totalHeight: number;
}

export interface TableVirtualizerConfig {
  estimatedRowHeight: number;
  detailEstimate: number;
}

export interface ScrollAnchor {
  key: string;
  logicalIndex: number;
  intraRowOffset: number;
}

export type ScrollAlignment = 'start' | 'center' | 'end' | 'nearest';

const MEASUREMENT_EPSILON = 0.25;
const MAX_BOOTSTRAP_SAMPLES = 16;
const MIN_BOOTSTRAP_SAMPLES = 4;

function isValidHeight(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function normalizedHeight(value: number, fallback: number): number {
  return isValidHeight(value) ? value : fallback;
}

function blockHeights(input: VirtualizerInput): number[] {
  const summaryEstimate = normalizedHeight(input.estimatedRowHeight, 1);
  const detailEstimate = normalizedHeight(input.detailEstimate, 1);

  return input.keys.map((key) => {
    const measurement = input.measurements.get(key);
    const summaryHeight = isValidHeight(measurement?.summary) ? measurement.summary : summaryEstimate;
    const detailHeight = input.expandedKeys.has(key)
      ? isValidHeight(measurement?.detail) ? measurement.detail : detailEstimate
      : 0;

    return summaryHeight + detailHeight;
  });
}

function prefixOffsets(heights: readonly number[]): number[] {
  const prefix = [0];

  for (const height of heights) {
    prefix.push(prefix[prefix.length - 1] + height);
  }

  return prefix;
}

function firstIntersectingBlock(prefix: readonly number[], start: number): number {
  let low = 0;
  let high = prefix.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (prefix[middle + 1] < start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return Math.min(low, prefix.length - 2);
}

function lastIntersectingBlock(prefix: readonly number[], end: number): number {
  let low = 0;
  let high = prefix.length - 2;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (prefix[middle] <= end) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return Math.max(0, low);
}

export function calculateVirtualRange(input: VirtualizerInput): VirtualRange {
  if (input.keys.length === 0) {
    return {start: 0, end: 0, paddingBefore: 0, paddingAfter: 0, totalHeight: 0};
  }

  const prefix = prefixOffsets(blockHeights(input));
  const totalHeight = prefix[prefix.length - 1];
  const scrollOffset = Math.max(0, Number.isFinite(input.scrollOffset) ? input.scrollOffset : 0);
  const viewportHeight = Math.max(0, Number.isFinite(input.viewportHeight) ? input.viewportHeight : 0);
  const overscan = Math.max(0, Number.isFinite(input.overscan) ? input.overscan : 0);
  const rangeStart = Math.max(0, scrollOffset - overscan);
  const rangeEnd = scrollOffset + viewportHeight + overscan;
  const start = firstIntersectingBlock(prefix, rangeStart);
  const last = lastIntersectingBlock(prefix, rangeEnd);
  const end = Math.max(start + 1, last + 1);

  return {
    start,
    end,
    paddingBefore: prefix[start],
    paddingAfter: Math.max(0, totalHeight - prefix[end]),
    totalHeight,
  };
}

export class TableVirtualizer {
  private config: TableVirtualizerConfig;
  private keys: string[] = [];
  private expandedKeys = new Set<string>();
  private measurements = new Map<string, RowMeasurement>();
  private prefix: number[] = [0];
  private prefixDirty = true;
  private bootstrapSamples = new Map<string, number>();
  private frozenMean: number | undefined;
  private initialCohortKeys: Set<string> | undefined;

  constructor(config: TableVirtualizerConfig) {
    this.config = {...config};
  }

  public configure(config: TableVirtualizerConfig): void {
    const changed = this.config.estimatedRowHeight !== config.estimatedRowHeight
      || this.config.detailEstimate !== config.detailEstimate;

    this.config = {...config};

    if (changed && this.frozenMean === undefined && this.bootstrapSamples.size < MIN_BOOTSTRAP_SAMPLES) {
      this.prefixDirty = true;
    }
  }

  public setRows(keys: readonly string[], expandedKeys: ReadonlySet<string>): void {
    this.keys = [...keys];
    this.expandedKeys = new Set(expandedKeys);
    this.removeMissingKeys(new Set(this.keys));
    this.prefixDirty = true;
  }

  public recordSummaryMeasurement(key: string, height: number): boolean {
    if (!this.keys.includes(key) || !isValidHeight(height)) {
      return false;
    }

    const previous = this.measurements.get(key)?.summary;

    if (isValidHeight(previous) && Math.abs(previous - height) <= MEASUREMENT_EPSILON) {
      return false;
    }

    const measurement = this.measurements.get(key) ?? {};

    measurement.summary = height;
    this.measurements.set(key, measurement);
    this.prefixDirty = true;

    if (this.frozenMean === undefined) {
      this.bootstrapSamples.set(key, height);
      this.freezeBootstrapIfReady();
    }

    return true;
  }

  public recordDetailMeasurement(key: string, height: number): boolean {
    if (!this.keys.includes(key) || !isValidHeight(height)) {
      return false;
    }

    const previous = this.measurements.get(key)?.detail;

    if (isValidHeight(previous) && Math.abs(previous - height) <= MEASUREMENT_EPSILON) {
      return false;
    }

    const measurement = this.measurements.get(key) ?? {};

    measurement.detail = height;
    this.measurements.set(key, measurement);
    this.prefixDirty = true;

    return true;
  }

  public clearDetailMeasurement(key: string): boolean {
    const measurement = this.measurements.get(key);

    if (measurement?.detail === undefined) {
      return false;
    }

    delete measurement.detail;

    if (measurement.summary === undefined) {
      this.measurements.delete(key);
    }

    this.prefixDirty = true;

    return true;
  }

  public removeMissingKeys(keys: ReadonlySet<string>): void {
    for (const key of this.measurements.keys()) {
      if (!keys.has(key)) {
        this.measurements.delete(key);
      }
    }

    for (const key of this.bootstrapSamples.keys()) {
      if (!keys.has(key)) {
        this.bootstrapSamples.delete(key);
      }
    }

    if (this.initialCohortKeys !== undefined) {
      for (const key of this.initialCohortKeys) {
        if (!keys.has(key)) {
          this.initialCohortKeys.delete(key);
        }
      }
    }

    this.prefixDirty = true;
  }

  public resetWidthEpoch(): void {
    this.measurements.clear();
    this.bootstrapSamples.clear();
    this.frozenMean = undefined;
    this.initialCohortKeys = undefined;
    this.prefixDirty = true;
  }

  public effectiveSummaryEstimate(): number {
    if (this.frozenMean !== undefined) {
      return this.frozenMean;
    }

    if (this.bootstrapSamples.size >= MIN_BOOTSTRAP_SAMPLES) {
      return this.runningMean();
    }

    return this.config.estimatedRowHeight;
  }

  public range(scrollOffset: number, viewportHeight: number, overscan: number): VirtualRange {
    if (this.initialCohortKeys === undefined && this.keys.length > 0) {
      const initialRange = calculateVirtualRange(this.input(scrollOffset, viewportHeight, overscan));

      this.initialCohortKeys = new Set(this.keys.slice(initialRange.start, initialRange.end));
    }

    return calculateVirtualRange(this.input(scrollOffset, viewportHeight, overscan));
  }

  public offsetOf(key: string): number | undefined {
    const index = this.keys.indexOf(key);

    if (index < 0) {
      return undefined;
    }

    this.ensurePrefix();

    return this.prefix[index];
  }

  public captureAnchor(scrollOffset: number): ScrollAnchor | undefined {
    if (this.keys.length === 0) {
      return undefined;
    }

    this.ensurePrefix();

    const offset = Math.max(0, scrollOffset);
    const index = Math.min(this.keys.length - 1, firstIntersectingBlock(this.prefix, offset));

    return {
      key: this.keys[index],
      logicalIndex: index,
      intraRowOffset: Math.max(0, offset - this.prefix[index]),
    };
  }

  public restoreAnchor(anchor: ScrollAnchor, maxScrollTop: number): number {
    this.ensurePrefix();

    const existingIndex = this.keys.indexOf(anchor.key);
    const index = existingIndex >= 0
      ? existingIndex
      : Math.min(Math.max(anchor.logicalIndex, 0), Math.max(0, this.keys.length - 1));
    const nextOffset = this.prefix[index] + anchor.intraRowOffset;

    return Math.min(Math.max(0, maxScrollTop), Math.max(0, nextOffset));
  }

  public offsetForRow(
    key: string,
    align: ScrollAlignment,
    viewportHeight: number,
    scrollOffset: number,
  ): number | undefined {
    const index = this.keys.indexOf(key);

    if (index < 0) {
      return undefined;
    }

    this.ensurePrefix();

    const start = this.prefix[index];
    const end = this.prefix[index + 1];
    const height = end - start;
    const viewport = Math.max(0, viewportHeight);
    const current = Math.max(0, scrollOffset);

    if (align === 'center') {
      return Math.max(0, start - (viewport - height) / 2);
    }

    if (align === 'end') {
      return Math.max(0, end - viewport);
    }

    if (align === 'nearest') {
      if (start < current) {
        return start;
      }

      if (end > current + viewport) {
        return Math.max(0, end - viewport);
      }

      return current;
    }

    return start;
  }

  private input(scrollOffset: number, viewportHeight: number, overscan: number): VirtualizerInput {
    return {
      keys: this.keys,
      expandedKeys: this.expandedKeys,
      measurements: this.measurements,
      estimatedRowHeight: this.effectiveSummaryEstimate(),
      detailEstimate: this.config.detailEstimate,
      scrollOffset,
      viewportHeight,
      overscan,
    };
  }

  private ensurePrefix(): void {
    if (!this.prefixDirty) {
      return;
    }

    this.prefix = prefixOffsets(blockHeights(this.input(0, 0, 0)));
    this.prefixDirty = false;
  }

  private runningMean(): number {
    let sum = 0;

    for (const height of this.bootstrapSamples.values()) {
      sum += height;
    }

    return sum / this.bootstrapSamples.size;
  }

  private freezeBootstrapIfReady(): void {
    if (this.bootstrapSamples.size < MIN_BOOTSTRAP_SAMPLES) {
      return;
    }

    const cohortStable = this.initialCohortKeys !== undefined
      && this.initialCohortKeys.size >= MIN_BOOTSTRAP_SAMPLES
      && [...this.initialCohortKeys].every((key) => this.bootstrapSamples.has(key));

    if (this.bootstrapSamples.size >= MAX_BOOTSTRAP_SAMPLES || cohortStable) {
      this.frozenMean = this.runningMean();
    }
  }
}
