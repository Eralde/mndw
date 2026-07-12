import type {WidgetSize} from './widget-size.js';

const GRID_LAYOUT_KEY = 'mndw:dashboard:grid-layout';
const WIDGET_TILE_ID = /^widget-(.+):([1-9]\d*)$/;

export interface PersistedGridTile {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function parseWidgetTileId(tileId: string): {pluginName: string; counter: number} | null {
  const match = WIDGET_TILE_ID.exec(tileId);

  if (match === null) {
    return null;
  }

  const counter = Number(match[2]);

  if (!Number.isSafeInteger(counter) || counter < 1) {
    return null;
  }

  return {pluginName: match[1], counter};
}

function isPersistedTile(value: unknown): value is PersistedGridTile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const tile = value as PersistedGridTile;

  return typeof tile.id === 'string'
    && Number.isInteger(tile.x) && tile.x >= 0
    && Number.isInteger(tile.y) && tile.y >= 0
    && Number.isInteger(tile.w) && tile.w > 0
    && Number.isInteger(tile.h) && tile.h > 0;
}

/**
 * Projects a raw grid node (e.g. a GridStack `save()` entry) to a durable
 * {@link PersistedGridTile}, or `null` when it lacks a complete, valid `{id,x,y,w,h}`.
 */
export function projectPersistedTile(node: unknown): PersistedGridTile | null {
  if (!isPersistedTile(node)) {
    return null;
  }

  return {id: node.id, x: node.x, y: node.y, w: node.w, h: node.h};
}

function clearGridLayout(): void {
  try {
    localStorage.removeItem(GRID_LAYOUT_KEY);
  } catch (error) {
    console.error('[mndw] Failed to clear grid dashboard layout:', error);
  }
}

export function saveGridLayout(layout: PersistedGridTile[]): void {
  const persistedLayout = layout.map(({id, x, y, w, h}) => ({id, x, y, w, h}));

  try {
    localStorage.setItem(GRID_LAYOUT_KEY, JSON.stringify(persistedLayout));
  } catch (error) {
    console.error('[mndw] Failed to save grid dashboard layout:', error);
  }
}

export function loadGridLayout(
  resolveWidgetSize: (pluginName: string) => WidgetSize | undefined,
): PersistedGridTile[] | null {
  let raw: string | null;

  try {
    raw = localStorage.getItem(GRID_LAYOUT_KEY);
  } catch (error) {
    console.error('[mndw] Failed to load grid dashboard layout:', error);

    return null;
  }

  if (raw === null) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('[mndw] Failed to parse grid dashboard layout, discarding:', error);
    clearGridLayout();

    return null;
  }

  if (!Array.isArray(parsed)) {
    console.warn('[mndw] Grid dashboard layout is not an array, discarding');
    clearGridLayout();

    return null;
  }

  const tileIds = new Set<string>();
  const layout: PersistedGridTile[] = [];

  for (const tile of parsed) {
    if (!isPersistedTile(tile) || tileIds.has(tile.id)) {
      continue;
    }

    const widget = parseWidgetTileId(tile.id);

    if (widget === null) {
      continue;
    }

    const size = resolveWidgetSize(widget.pluginName);

    if (size === undefined) {
      continue;
    }

    const w = Math.min(Math.max(tile.w, size.minW ?? 1), 12);
    const h = Math.max(tile.h, size.minH ?? 1);

    tileIds.add(tile.id);
    layout.push({id: tile.id, x: Math.min(tile.x, 12 - w), y: tile.y, w, h});
  }

  return layout;
}
