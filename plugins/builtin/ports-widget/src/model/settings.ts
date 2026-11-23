export const ROW_KINDS = [
  'description',
  'speed',
  'duplex',
  'rx-total',
  'tx-total',
  'rx-rate',
  'tx-rate',
  'rx-errors',
  'tx-errors',
  'rx-dropped',
  'tx-dropped',
  'separator',
] as const;

export type RowKind = (typeof ROW_KINDS)[number];

export interface WidgetSettings {
  readonly rows: readonly RowKind[];
}

export const MAX_ROWS = 8;

export const DEFAULT_SETTINGS: WidgetSettings = {
  rows: ['description', 'speed', 'duplex'],
};

const VALID_ROWS: ReadonlySet<string> = new Set(ROW_KINDS);

export function parseSettings(value: unknown): WidgetSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_SETTINGS;
  }

  const rows = (value as Record<string, unknown>).rows;

  if (!Array.isArray(rows) || rows.length > MAX_ROWS) {
    return DEFAULT_SETTINGS;
  }

  const seen = new Set<string>();

  for (const row of rows) {
    if (typeof row !== 'string' || !VALID_ROWS.has(row)) {
      return DEFAULT_SETTINGS;
    }

    if (row !== 'separator' && seen.has(row)) {
      return DEFAULT_SETTINGS;
    }

    seen.add(row);
  }

  return {rows: [...rows] as RowKind[]};
}
