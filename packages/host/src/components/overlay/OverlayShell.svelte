<script lang="ts">
import type {OverlayLayerView} from '../../services/overlay/overlay-manager.svelte.js';

interface Props {
  layer: OverlayLayerView;
}

let {layer}: Props = $props();

const uid = Math.random().toString(36).slice(2);
const titleId = `mndw-overlay-title-${uid}`;
const descId = `mndw-overlay-desc-${uid}`;

// Places the plugin's mount target inside the shell body. The node is created by
// the host and mounted into by the plugin framework; it is never re-parented after.
function appendContent(node: HTMLElement, target: HTMLElement) {
  node.appendChild(target);

  return {
    destroy() {
      if (target.parentNode === node) {
        node.removeChild(target);
      }
    },
  };
}

const sizeStyle = $derived.by(() => {
  return [
    layer.sizing.width ? `width:${layer.sizing.width}` : '',
    layer.sizing.height ? `height:${layer.sizing.height}` : '',
    layer.sizing.maxWidth ? `max-width:${layer.sizing.maxWidth}` : '',
    layer.sizing.maxHeight ? `max-height:${layer.sizing.maxHeight}` : '',
  ]
    .filter(Boolean)
    .join(';');
});
</script>

<div
  class="mndw-overlay-dialog mndw-overlay-dialog--{layer.kind} {layer.className ?? ''}"
  role="dialog"
  aria-modal={layer.kind === 'modal' ? 'true' : undefined}
  aria-labelledby={layer.shell?.title ? titleId : undefined}
  aria-describedby={layer.shell?.description ? descId : undefined}
  style={sizeStyle}
>
  {#if layer.shell?.title || layer.shell?.showCloseButton}
    <header class="mndw-overlay-dialog__header">
      {#if layer.shell?.title}
        <h2
          id={titleId}
          class="mndw-overlay-dialog__title"
        >
          {layer.shell.title}
        </h2>
      {/if}

      {#if layer.shell?.showCloseButton}
        <button
          type="button"
          class="mndw-overlay-dialog__close"
          aria-label="Close"
          onclick={() => layer.close(undefined, 'action')}
        >
          &times;
        </button>
      {/if}
    </header>
  {/if}

  {#if layer.shell?.description}
    <p
      id={descId}
      class="mndw-overlay-dialog__description"
    >
      {layer.shell.description}
    </p>
  {/if}

  <div
    class="mndw-overlay-dialog__body"
    use:appendContent={layer.contentElement}
  >
  </div>
</div>

<style>
.mndw-overlay-dialog {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--mndw-surface);
  color: var(--mndw-text);
  border: 1px solid var(--mndw-border);
  box-shadow: var(--mndw-shadow-2);
  font-family: var(--mndw-font-sans);
  pointer-events: auto;
}

.mndw-overlay-dialog--modal {
  border-radius: 8px;
}

.mndw-overlay-dialog--drawer {
  border-radius: 0;
  height: 100%;
}

.mndw-overlay-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--mndw-border);
}

.mndw-overlay-dialog__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.mndw-overlay-dialog__close {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--mndw-text-subtle);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.mndw-overlay-dialog__close:hover {
  background: color-mix(in srgb, var(--mndw-text) 8%, transparent);
  color: var(--mndw-text);
}

.mndw-overlay-dialog__description {
  margin: 0;
  padding: 8px 16px 0;
  font-size: 13px;
  color: var(--mndw-text-subtle);
}

.mndw-overlay-dialog__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}
</style>
