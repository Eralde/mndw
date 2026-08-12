<script lang="ts">
import {hostT} from '../services/host-i18n.svelte.js';
import {appState} from '../state/app.svelte.js';
interface OrderCard {
  id: string;
  label: string;
}

interface Props {
  open: boolean;
  cards: OrderCard[];
  onCommit: (order: string[]) => void;
}

let {open, cards, onCommit}: Props = $props();

let draft = $state<OrderCard[]>([]);
let dragIndex: number | null = $state(null);
let cardRefs: HTMLElement[] = $state([]);

$effect(() => {
  if (open) {
    draft = cards.map((card) => ({...card}));
    dragIndex = null;
  }
});

function commit(): void {
  onCommit(draft.map((card) => card.id));
}

function move(index: number, delta: number): void {
  const targetIndex = index + delta;

  if (targetIndex < 0 || targetIndex >= draft.length) {
    return;
  }

  const next = [...draft];
  const [card] = next.splice(index, 1);

  if (card !== undefined) {
    next.splice(targetIndex, 0, card);
    draft = next;
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    commit();
  }
}

function handlePointerDown(event: PointerEvent, index: number): void {
  dragIndex = index;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function handlePointerMove(event: PointerEvent): void {
  const from = dragIndex;

  if (from === null) {
    return;
  }

  for (let index = 0; index < draft.length; index += 1) {
    if (index === from) {
      continue;
    }

    const rect = cardRefs[index]?.getBoundingClientRect();

    if (
      rect !== undefined && event.clientY >= rect.top
      && event.clientY <= rect.bottom
    ) {
      move(from, index - from);
      dragIndex = index;

      return;
    }
  }
}

function handlePointerUp(): void {
  dragIndex = null;
}
</script>

{#if open}
  <div
    class="mndw-floating-panel-backdrop"
    onclick={commit}
    role="presentation"
  >
    <div
      class="mndw-floating-panel mndw-order-overlay"
      onclick={(event) => event.stopPropagation()}
      onkeydown={handleKeydown}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="arrange-widgets-title"
      data-locale={appState.locale}
    >
      <div class="mndw-floating-panel__header">
        <h3 id="arrange-widgets-title">{hostT('dashboard.arrange-widgets')}</h3>
        <mndw-button
          variant="ghost"
          class="mndw-floating-panel__close"
          onclick={commit}
          aria-label={hostT('common.close')}
        >
          ×
        </mndw-button>
      </div>
      <ul class="mndw-order-overlay__list">
        {#each draft as card, index (card.id)}
          <li
            class="mndw-order-card"
            class:mndw-order-card--dragging={dragIndex === index}
            bind:this={cardRefs[index]}
          >
            <span
              class="mndw-order-card__handle"
              onpointerdown={(event) => handlePointerDown(event, index)}
              onpointermove={handlePointerMove}
              onpointerup={handlePointerUp}
              aria-hidden="true"
            >☰</span>
            <span class="mndw-order-card__label">{card.label}</span>
            <span class="mndw-order-card__moves">
              <mndw-button
                variant="ghost"
                onclick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={hostT('dashboard.move-up', {label: card.label})}
              >
                ▲
              </mndw-button>
              <mndw-button
                variant="ghost"
                onclick={() => move(index, 1)}
                disabled={index === draft.length - 1}
                aria-label={hostT('dashboard.move-down', {label: card.label})}
              >
                ▼
              </mndw-button>
            </span>
          </li>
        {/each}
      </ul>
    </div>
  </div>
{/if}
