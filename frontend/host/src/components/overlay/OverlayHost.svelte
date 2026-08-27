<script lang="ts">
import {
  type Component,
  mount as svelteMount,
  unmount as svelteUnmount,
} from 'svelte';
import OverlayShell from './OverlayShell.svelte';
import {
  type OverlayLayerView,
  type OverlayRuntime,
  defaultOverlayRuntime,
} from '../../services/overlay/overlay-manager.svelte.js';

let {runtime = defaultOverlayRuntime}: {runtime?: OverlayRuntime} = $props();

// NOTE: The host-owned BackendApprovalModal.svelte still uses a standalone fixed
// overlay at z-index: 2000 and is intentionally NOT migrated in this rollout. The
// overlay host deliberately stacks BELOW it (z-index base 1000, +1 per layer) so
// approval prompts always win. Migrating that modal is a follow-up.
const Z_BASE = 1000;

const layers = $derived(runtime.store.layers);

function layerZ(index: number): number {
  return Z_BASE + index;
}

function isBlocking(layer: OverlayLayerView): boolean {
  return layer.kind === 'modal' || layer.kind === 'drawer';
}

function positionerStyle(layer: OverlayLayerView): string {
  if (layer.kind === 'popover') {
    // Position is computed from measured content on first render (see renderLayer);
    // keep the popover hidden until then so it never flashes at the corner (0,0).
    return layer.position
      ? `position:absolute;top:${layer.position.top}px;left:${layer.position.left}px`
      : 'position:absolute;visibility:hidden';
  }

  return '';
}

// Appends the host-created layer root and, for shell-backed layers, mounts the
// shell chrome into it. The plugin's contentElement is never re-parented.
function renderLayer(node: HTMLElement, layer: OverlayLayerView) {
  node.appendChild(layer.hostElement);

  if (layer.kind === 'drawer' && layer.placement === 'bottom') {
    layer.hostElement.style.display = 'flex';
    layer.hostElement.style.flexDirection = 'column';
    layer.hostElement.style.justifyContent = 'flex-end';
    layer.hostElement.style.width = '100%';
    layer.hostElement.style.height = '100%';
    layer.hostElement.style.minHeight = '0';
  }

  let shellApp: Record<string, unknown> | undefined;

  if (layer.shell) {
    // `mount`'s `Exports` generic can't be inferred from svelte2tsx's isomorphic
    // class+fn type for a no-export component (TS2510). Leave nothing to infer:
    // pin both generics AND cast the component to exactly that shape, so the
    // options object also checks against a plain `MountOptions<{layer}>`.
    const Shell = OverlayShell as unknown as Component<
      {layer: OverlayLayerView},
      Record<string, never>
    >;

    shellApp = svelteMount<{layer: OverlayLayerView}, Record<string, never>>(
      Shell,
      {target: layer.hostElement, props: {layer}},
    );
  }

  // Let plugin content finish its first layout before exposing anchored placement.
  // This prevents a partially-rendered popover from flashing at the preferred side.
  requestAnimationFrame(() => {
    if (layer.state !== 'closed') {
      layer.reposition();
    }
  });

  return {
    destroy() {
      if (shellApp) {
        void svelteUnmount(shellApp);
      }

      layer.hostElement.remove();
    },
  };
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') {
    return;
  }

  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].closeOnEscape) {
      layers[i].closeWithReason('escape');
      event.stopPropagation();

      return;
    }
  }
}

// Outside-click is evaluated from the top down; a dismissal does not fall through.
function handlePointerDown(event: MouseEvent): void {
  const path = event.composedPath();

  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];

    if (
      path.includes(layer.hostElement)
      || (layer.anchorElement && path.includes(layer.anchorElement))
    ) {
      return;
    }

    if (layer.closeOnOutsideClick) {
      layer.closeWithReason('outside-click');

      return;
    }

    // Topmost blocking layer swallows clicks that reach its backdrop.
    if (isBlocking(layer)) {
      return;
    }
  }
}

$effect(() => {
  const lock = layers.some((layer) => layer.lockScroll);
  const previous = document.body.style.overflow;

  if (lock) {
    document.body.style.overflow = 'hidden';
  }

  return () => {
    document.body.style.overflow = previous;
  };
});
</script>

<svelte:window
  onkeydown={handleKeydown}
  onpointerdown={handlePointerDown}
/>

{#each layers as layer, index (layer.id)}
  <div
    class="mndw-overlay-layer mndw-overlay-layer--{layer.kind}"
    style:z-index={layerZ(index)}
  >
    {#if isBlocking(layer) && layer.backdrop}
      <div
        class="mndw-overlay-backdrop"
        aria-hidden="true"
      >
      </div>
    {/if}

    <div
      class="mndw-overlay-positioner mndw-overlay-positioner--{layer.kind} mndw-overlay-positioner--{layer.placement} {layer.mobileSheet ? 'mndw-overlay-positioner--sheet' : ''}"
      style={positionerStyle(layer)}
      use:renderLayer={layer}
    >
    </div>
  </div>
{/each}

<style>
.mndw-overlay-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
}
.mndw-overlay-backdrop {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, #000 40%, transparent);
  pointer-events: auto;
}
.mndw-overlay-positioner {
  position: absolute;
  inset: 0;
  display: flex;
  pointer-events: none;
}
.mndw-overlay-positioner :global(.mndw-overlay-content),
.mndw-overlay-positioner :global(.mndw-overlay-dialog) {
  pointer-events: auto;
}
.mndw-overlay-positioner--modal {
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.mndw-overlay-positioner--drawer {
  align-items: stretch;
  justify-content: flex-end;
}
.mndw-overlay-positioner--bottom {
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-end;
}
.mndw-overlay-positioner--popover {
  display: block;
  inset: auto;
}
.mndw-overlay-positioner--custom {
  align-items: center;
  justify-content: center;
}
.mndw-overlay-positioner--sheet {
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-end;
  padding: 0;
}
</style>
