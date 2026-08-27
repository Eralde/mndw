<script lang="ts">
import {parseWidgetTileId} from './grid-layout-persistence.js';
import {ensureTileController} from './tile-controller.js';
import {getHostServices} from '../host-services-context.js';

interface Props {
  order: string[];
  onRemoveRequest: (tileId: string) => void;
}

let {order, onRemoveRequest}: Props = $props();
const services = getHostServices();
const registry = services.registry;
const pluginContextServices = {
  locale: services.locale,
  palette: services.palette,
};

/**
 * Svelte action: adopts the shared tile controller's frame into this flow shell.
 * appendChild reparents the live DOM node from wherever it was (a destroyed desktop
 * grid item, a previous mobile mount) without remounting the plugin. No detach on
 * destroy — the controller keeps owning the frame; the next shell adopts it.
 */
function adoptTile(node: HTMLElement, tileId: string): void {
  const parsed = parseWidgetTileId(tileId);

  if (parsed === null) {
    node.remove();

    return;
  }

  const controller = ensureTileController(
    pluginContextServices,
    registry,
    parsed.pluginName,
    `${parsed.pluginName}:${parsed.counter}`,
    onRemoveRequest,
  );

  if (controller === null) {
    node.remove();

    return;
  }

  node.appendChild(controller.frame);
}
</script>

<div class="mndw-mobile-dashboard mndw-scrollbar">
  {#each order as tileId (tileId)}
    <div
      class="mndw-mobile-tile"
      use:adoptTile={tileId}
    >
    </div>
  {/each}
</div>
