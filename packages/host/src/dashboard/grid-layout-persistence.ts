import {type WidgetSize, getWidgetSize} from './widget-size.js';

const GRID_LAYOUT_KEY = 'mndw:dashboard:grid-layout';
const WIDGET_TILE_ID = /^widget-(.+):([1-9]\d*)$/;

export interface PersistedGridTile {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardLayout {
  tiles: PersistedGridTile[];
  mobileOrder: string[];
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
    console.error('[mndw] Failed to clear dashboard layout:', error);
  }
}

/**
 * Stable ordering for widget tile ids: plugin name lexicographically, then the
 * instance counter numerically (`widget-a:2` before `widget-a:10`). Unparsable
 * ids fall back to a plain string compare.
 */
export function compareTileIds(a: string, b: string): number {
  const parsedA = parseWidgetTileId(a);
  const parsedB = parseWidgetTileId(b);

  if (parsedA === null || parsedB === null) {
    return a.localeCompare(b);
  }

  return parsedA.pluginName.localeCompare(parsedB.pluginName)
    || parsedA.counter - parsedB.counter;
}

function deriveMobileOrder(tiles: PersistedGridTile[]): string[] {
  return [...tiles]
    .sort((a, b) => a.y - b.y || a.x - b.x || compareTileIds(a.id, b.id))
    .map((tile) => tile.id);
}

/**
 * Sanitizes a raw stored order against the sanitized tiles: keeps only string ids
 * that exist in `tiles`, drops duplicates, and appends any tile id the order is
 * missing (in derived y/x order) so new widgets always have a mobile position.
 */
function reconcileMobileOrder(order: unknown, tiles: PersistedGridTile[]): string[] {
  const available = new Set(tiles.map((tile) => tile.id));
  const seen = new Set<string>();
  const result: string[] = [];

  if (Array.isArray(order)) {
    for (const id of order) {
      if (typeof id === 'string' && available.has(id) && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
  }

  for (const id of deriveMobileOrder(tiles)) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  return result;
}

/**
 * Desktop placement for a tile added while the mobile renderer is active and no
 * GridStack instance exists to auto-place it: full-left, one row past the bottom
 * of the current desktop layout, manifest default size.
 */
export function placeTileBelowLayout(
  tiles: PersistedGridTile[],
  size: WidgetSize,
): {x: number; y: number; w: number; h: number} {
  const normalized = getWidgetSize(size);
  const y = tiles.reduce((max, tile) => Math.max(max, tile.y + tile.h), 0);

  return {x: 0, y, w: Math.min(normalized.w, 12), h: normalized.h};
}

function sanitizeTiles(
  rawTiles: unknown[],
  resolveWidgetSize: (pluginName: string) => WidgetSize | undefined,
): PersistedGridTile[] {
  const tileIds = new Set<string>();
  const tiles: PersistedGridTile[] = [];

  for (const tile of rawTiles) {
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
    tiles.push({id: tile.id, x: Math.min(tile.x, 12 - w), y: tile.y, w, h});
  }

  return tiles;
}

function isDashboardLayout(value: unknown): value is {tiles: unknown[]; mobileOrder?: unknown} {
  return typeof value === 'object' && value !== null
    && !('version' in value)
    && Array.isArray((value as {tiles?: unknown}).tiles);
}

export function saveDashboardLayout(layout: DashboardLayout): void {
  const persisted: DashboardLayout = {
    tiles: layout.tiles.map(({id, x, y, w, h}) => ({id, x, y, w, h})),
    mobileOrder: [...layout.mobileOrder],
  };

  try {
    localStorage.setItem(GRID_LAYOUT_KEY, JSON.stringify(persisted));
  } catch (error) {
    console.error('[mndw] Failed to save dashboard layout:', error);
  }
}

export function loadDashboardLayout(
  resolveWidgetSize: (pluginName: string) => WidgetSize | undefined,
): DashboardLayout | null {
  let raw: string | null;

  try {
    raw = localStorage.getItem(GRID_LAYOUT_KEY);
  } catch (error) {
    console.error('[mndw] Failed to load dashboard layout:', error);

    return null;
  }

  if (raw === null) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('[mndw] Failed to parse dashboard layout, discarding:', error);
    clearGridLayout();

    return null;
  }

  if (!isDashboardLayout(parsed)) {
    console.warn('[mndw] Malformed dashboard layout, discarding');
    clearGridLayout();

    return null;
  }

  const tiles = sanitizeTiles(parsed.tiles, resolveWidgetSize);

  return {
    tiles,
    mobileOrder: reconcileMobileOrder(parsed.mobileOrder, tiles),
  };
}
