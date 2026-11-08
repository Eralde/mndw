import type {GridStack} from 'gridstack';
import {ensureTileController, getTileController} from './tile-controller.js';
import {getNextInstanceId} from './widget-counter.js';
import {getWidgetSize} from './widget-size.js';
import type {PluginContextServices} from '../runtime/plugin-context.js';
import type {PluginRegistry} from '../runtime/plugin-registry.js';

/** A restored tile's persisted geometry plus its parsed instance id. */
export interface RestoredTilePosition {
  x: number;
  y: number;
  w: number;
  h: number;
  instanceId: string;
}

/**
 * Adds a widget tile to the grid and attaches its shared tile controller's frame.
 * Returns the tile id (`widget-<instanceId>`), or `null` when the plugin is
 * unavailable, is not a widget, or GridStack produced no content element.
 *
 * New tiles omit `x`/`y` so GridStack auto-places them; restored tiles override
 * `x`/`y`/`w`/`h`/`instance-id` while the current manifest `minW`/`minH` stay
 * authoritative. A controller that already exists (returning from the mobile
 * renderer) is reused — its frame reparents into the new grid item, keeping the
 * live plugin instance.
 */
export function addWidgetTile(
  pluginContextServices: PluginContextServices,
  registry: Pick<PluginRegistry, 'get'>,
  grid: GridStack,
  pluginName: string,
  onRemoveRequest: (tileId: string) => void,
  position?: RestoredTilePosition,
): string | null {
  const plugin = registry.get(pluginName);

  if (plugin?.entry.type !== 'widget') {
    return null;
  }

  const instanceId = position?.instanceId ?? getNextInstanceId(pluginName);
  const controller = ensureTileController(pluginContextServices, registry, pluginName, instanceId, onRemoveRequest);

  if (controller === null) {
    return null;
  }

  const size = getWidgetSize(plugin.entry.size);
  const gridItem = grid.addWidget({
    id: controller.id,
    x: position?.x,
    y: position?.y,
    w: position?.w ?? size.w,
    h: position?.h ?? size.h,
    minW: size.minW,
    minH: size.minH,
  });

  const contentEl = gridItem.querySelector<HTMLElement>('.grid-stack-item-content');

  if (contentEl === null) {
    // GridStack gave us a tile without its content surface: roll it back. The grid's
    // `removed` event routes to the page's removal handler, which disposes the
    // controller too.
    grid.removeWidget(gridItem, true);

    return null;
  }

  contentEl.appendChild(controller.frame);

  // GridStack init's drag during addWidget(), before the title bar DOM exists.
  // Force re-init so the handle selector finds the now-present title bar element.
  grid.prepareDragDrop(gridItem, true);

  return controller.id;
}

/** Forwards new grid-unit dimensions to a tile's optional `onResize`, isolating throws. */
export function resizeWidgetTile(id: string, size: {w: number; h: number}): void {
  const controller = getTileController(id);
  const instance = controller?.handle.getMounted()?.instance;

  if (instance?.onResize === undefined) {
    return;
  }

  try {
    instance.onResize(size);
  } catch (error) {
    console.error(`[mndw] Widget "${controller?.pluginName}" onResize failed:`, error);
  }
}
