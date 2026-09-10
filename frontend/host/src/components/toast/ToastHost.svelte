<script lang="ts">
import {onMount} from 'svelte';
import {mobileMediaQuery} from '../../layout/breakpoint.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import {
  type Toast,
  type ToastStore,
  shouldDismissSwipe,
  toast as defaultStore,
} from '../../services/toast/toast.svelte.js';

let {store = defaultStore}: {store?: ToastStore} = $props();

const mobileQuery = mobileMediaQuery();
let isMobile = $state(mobileQuery.matches);

const handleBreakpointChange = (event: MediaQueryListEvent): void => {
  isMobile = event.matches;
  store.setMaxToasts(event.matches ? 3 : 4);
};

// Errors demand attention; success/info are advisory. Maps onto the alert kit.
function severity(variant: Toast['variant']): 'danger' | 'success' | 'info' {
  return variant === 'error' ? 'danger' : variant;
}

interface SwipeParams {
  enabled: boolean;
  onDismiss: () => void;
}

// Swipe-to-dismiss (mobile only). Horizontal drag translates the toast and, past the
// distance/velocity threshold (shouldDismissSwipe), dismisses it; otherwise it snaps
// back. `touch-action: pan-y` keeps vertical page scrolling working. The dismiss
// button remains the accessible, non-touch path — this is a progressive enhancement.
function swipeToDismiss(node: HTMLElement, params: SwipeParams) {
  let current = params;
  let pointerId: number | null = null;
  let startX = 0;
  let startTime = 0;
  let dragging = false;

  const reset = (animate: boolean): void => {
    node.style.transition = animate
      ? 'transform 0.15s ease, opacity 0.15s ease'
      : '';
    node.style.transform = '';
    node.style.opacity = '';
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (
      !current.enabled || event.pointerType === 'mouse' || pointerId !== null
    ) {
      return;
    }

    pointerId = event.pointerId;
    startX = event.clientX;
    startTime = event.timeStamp;
    dragging = true;
    node.style.transition = '';
    node.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || event.pointerId !== pointerId) {
      return;
    }

    const dx = event.clientX - startX;

    node.style.transform = `translateX(${dx}px)`;
    node.style.opacity = String(
      Math.max(0.3, 1 - Math.abs(dx) / node.offsetWidth),
    );
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!dragging || event.pointerId !== pointerId) {
      return;
    }

    const dx = event.clientX - startX;
    const elapsed = Math.max(1, event.timeStamp - startTime);
    const velocity = dx / elapsed;

    dragging = false;
    pointerId = null;

    if (shouldDismissSwipe(dx, node.offsetWidth, velocity)) {
      current.onDismiss();
    } else {
      reset(true);
    }
  };

  node.style.touchAction = 'pan-y';
  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', onPointerUp);

  return {
    update(next: SwipeParams): void {
      current = next;
    },
    destroy(): void {
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerUp);
    },
  };
}

onMount(() => {
  store.setMaxToasts(isMobile ? 3 : 4);
  mobileQuery.addEventListener('change', handleBreakpointChange);

  return () => {
    mobileQuery.removeEventListener('change', handleBreakpointChange);
  };
});
</script>

{#if store.toasts.length > 0}
  <div
    class="mndw-toast-host"
    class:mndw-toast-host--mobile={isMobile}
    role="region"
    aria-label={hostT('toast.region')}
  >
    {#each store.toasts as toast (toast.id)}
      <div
        class="mndw-toast mndw-alert mndw-alert--{severity(toast.variant)}"
        role={toast.variant === 'error' ? 'alert' : 'status'}
        aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
        use:swipeToDismiss={{enabled: isMobile, onDismiss: () => store.dismiss(toast.id)}}
      >
        <span class="mndw-toast__body">{toast.message}</span>
        <button
          type="button"
          class="mndw-toast__dismiss"
          aria-label={hostT('toast.dismiss')}
          onclick={() => store.dismiss(toast.id)}
        >
          <mndw-icon name="x"></mndw-icon>
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
.mndw-toast-host {
  position: fixed;
  z-index: 900; /* below the overlay layer base (1000) so modals stay above toasts */
  top: var(--mndw-space-4);
  right: var(--mndw-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--mndw-space-2);
  width: min(24rem, calc(100vw - 2 * var(--mndw-space-4)));
  pointer-events: none; /* the container is click-through; toasts opt back in */
}

.mndw-toast {
  display: flex;
  align-items: flex-start;
  gap: var(--mndw-space-2);
  pointer-events: auto;
  box-shadow: var(--mndw-shadow-md, 0 4px 12px rgb(0 0 0 / 0.15));
  will-change: transform;
}

.mndw-toast__body {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere; /* wrap the long joined dependency list cleanly */
}

.mndw-toast__dismiss {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  margin: calc(-1 * var(--mndw-space-1)) calc(-1 * var(--mndw-space-1)) 0 0;
  padding: 0;
  border: 0;
  border-radius: var(--mndw-radius-sm, 0.25rem);
  background: transparent;
  color: inherit;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
}

.mndw-toast__dismiss:hover {
  background: rgb(0 0 0 / 0.08);
}

.mndw-toast-host--mobile {
  top: auto;
  right: var(--mndw-space-3);
  bottom: calc(var(--mndw-space-3) + env(safe-area-inset-bottom, 0px));
  left: var(--mndw-space-3);
  width: auto;
}

/* On touch layouts the dismiss target meets the 44px minimum (WCAG 2.5.5). */
.mndw-toast-host--mobile .mndw-toast__dismiss {
  width: 2.75rem;
  height: 2.75rem;
  font-size: 1.5rem;
}

@media (prefers-reduced-motion: reduce) {
  .mndw-toast {
    transition: none !important;
  }
}
</style>
