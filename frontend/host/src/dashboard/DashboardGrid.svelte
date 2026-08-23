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
  onGridDestroyed: () => void;
  onWidgetRemoved: (widgetId: string) => void;
  onLayoutChanged: (layout: PersistedGridTile[]) => void;
  onWidgetResized: (widgetId: string, size: {w: number; h: number}) => void;
}

let {onGridReady, onGridDestroyed, onWidgetRemoved, onLayoutChanged,
  onWidgetResized}: Props = $props();

let container: HTMLElement;

// Persisted tile positions assume this base column count (see grid-layout-persistence.ts).
const BASE_COLUMN_COUNT = 12;
const RESIZE_INDICATOR_CLASS = 'mndw-grid-resize-indicator';
const RESIZE_INDICATOR_SELECTOR = `.${RESIZE_INDICATOR_CLASS}`;

function readGridSize(el: GridItemHTMLElement): {w: number; h: number} | null {
  const node = el.gridstackNode;

  if (
    node === undefined
    || !Number.isInteger(node.w)
    || !Number.isInteger(node.h)
  ) {
    return null;
  }

  return {w: node.w as number, h: node.h as number};
}

function clearResizeIndicator(el: GridItemHTMLElement): void {
  el.querySelector<HTMLElement>(RESIZE_INDICATOR_SELECTOR)?.remove();
}

function updateResizeIndicator(el: GridItemHTMLElement): void {
  const size = readGridSize(el);

  if (size === null) {
    clearResizeIndicator(el);

    return;
  }

  let indicator = el.querySelector<HTMLElement>(RESIZE_INDICATOR_SELECTOR);

  if (indicator === null) {
    indicator = document.createElement('div');
    indicator.className = RESIZE_INDICATOR_CLASS;
    indicator.setAttribute('aria-hidden', 'true');
    el.appendChild(indicator);
  }

  indicator.textContent = `${size.w} × ${size.h}`;
}

onMount(() => {
  const grid = GridStack.init(
    {
      column: BASE_COLUMN_COUNT,
      animate: true,
      float: false,
      cellHeight: 60,
      margin: 10,
      draggable: {handle: '.mndw-grid-tile__title'},
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

  grid.on('resizestart', (_event: Event, el: GridItemHTMLElement) => {
    updateResizeIndicator(el);
  });

  grid.on('resize', (_event: Event, el: GridItemHTMLElement) => {
    updateResizeIndicator(el);
  });

  grid.on('resizestop', (_event: Event, el: GridItemHTMLElement) => {
    clearResizeIndicator(el);

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
    grid.off('resizestart');
    grid.off('resize');
    grid.off('resizestop');
    container.querySelectorAll<HTMLElement>(RESIZE_INDICATOR_SELECTOR).forEach(
      (indicator) => {
        indicator.remove();
      },
    );
    grid.destroy(false);
    onGridDestroyed();
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
