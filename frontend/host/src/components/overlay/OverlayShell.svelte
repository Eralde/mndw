<script lang="ts">
import type {OverlayLayerView} from '../../services/overlay/overlay-manager.svelte.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import {appState} from '../../state/app.svelte.js';

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
  if (layer.mobileSheet) {
    return 'width:100%;height:auto;max-height:100dvh';
  }

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
  class="mndw-overlay-dialog mndw-overlay-dialog--{layer.kind} mndw-overlay-dialog--{layer.placement} {layer.mobileSheet ? 'mndw-overlay-dialog--sheet' : ''} {layer.className ?? ''}"
  data-locale={appState.locale}
  role="dialog"
  aria-modal={layer.kind === 'modal' || layer.kind === 'drawer' ? 'true' : undefined}
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
          aria-label={hostT('common.close')}
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
  border-radius: 0.5rem;
}

.mndw-overlay-dialog--drawer {
  border-radius: 0;
  height: 100%;
}

.mndw-overlay-dialog--bottom {
  border-right: none;
  border-bottom: none;
  border-left: none;
  border-radius: 0.75rem 0.75rem 0 0;
}
.mndw-overlay-dialog--sheet {
  border-right: none;
  border-bottom: none;
  border-left: none;
  border-radius: 0.75rem 0.75rem 0 0;
}

.mndw-overlay-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--mndw-border);
}

.mndw-overlay-dialog--sheet .mndw-overlay-dialog__header {
  flex-shrink: 0;
}

.mndw-overlay-dialog__title {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
}

.mndw-overlay-dialog__close {
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  border: none;
  border-radius: 0.25rem;
  background: transparent;
  color: var(--mndw-text-subtle);
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
}

.mndw-overlay-dialog__close:hover {
  background: color-mix(in srgb, var(--mndw-text) 8%, transparent);
  color: var(--mndw-text);
}

.mndw-overlay-dialog__description {
  margin: 0;
  padding: 0.5rem 1rem 0;
  font-size: 0.8125rem;
  color: var(--mndw-text-subtle);
}

.mndw-overlay-dialog__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 1rem;
}
.mndw-overlay-dialog--sheet .mndw-overlay-dialog__body {
  flex: 0 1 auto;
  min-height: 0;
  overflow: auto;
}

.mndw-overlay-dialog:global(.mndw-ui-select-sheet) .mndw-overlay-dialog__body {
  padding: 0;
  overflow: hidden;
}
</style>
