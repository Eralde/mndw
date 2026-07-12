<script lang="ts">
import type {
  GridItemHTMLElement,
  GridStack as GridStackType,
  GridStackNode,
  GridStackWidget,
} from 'gridstack';
import {GridStack} from 'gridstack';
import 'gridstack/dist/gridstack.min.css';
import {onMount} from 'svelte';
import {
  type PersistedGridTile,
  projectPersistedTile,
} from './grid-layout-persistence.js';

interface Props {
  onGridReady: (grid: GridStackType) => void;
  onWidgetRemoved: (widgetId: string) => void;
  onLayoutChanged: (layout: PersistedGridTile[]) => void;
  onWidgetResized: (widgetId: string, size: {w: number; h: number}) => void;
}

let {onGridReady, onWidgetRemoved, onLayoutChanged, onWidgetResized}: Props =
  $props();

let container: HTMLElement;

onMount(() => {
  const grid = GridStack.init(
    {
      column: 12,
      animate: true,
      float: false,
      cellHeight: 60,
      margin: 10,
      resizable: {handles: 'se'},
    },
    container,
  );

  // Register every listener before signalling readiness so restoration performed in
  // onGridReady can't race a change/remove event that has no handler yet.
  grid.on('removed', (_event: Event, items: GridStackNode[]) => {
    for (const item of items) {
      if (typeof item.id === 'string') {
        onWidgetRemoved(item.id);
      }
    }
  });

  const emitLayout = (): void => {
    const saved = grid.save(false);
    const layout = Array.isArray(saved)
      ? (saved as GridStackWidget[])
        .map(projectPersistedTile)
        .filter((tile): tile is PersistedGridTile => tile !== null)
      : [];

    onLayoutChanged(layout);
  };

  grid.on('added', emitLayout);
  grid.on('change', emitLayout);

  grid.on('resizestop', (_event: Event, el: GridItemHTMLElement) => {
    const node = el.gridstackNode;

    if (
      node !== undefined
      && typeof node.id === 'string'
      && Number.isInteger(node.w)
      && Number.isInteger(node.h)
    ) {
      onWidgetResized(node.id, {w: node.w as number, h: node.h as number});
    }
  });

  onGridReady(grid);

  return () => {
    grid.off('removed');
    grid.off('added');
    grid.off('change');
    grid.off('resizestop');
  };
});
</script>

<div class="mndw-grid-scroll mndw-scrollbar">
  <div
    class="grid-stack"
    bind:this={container}
  >
  </div>
</div>
