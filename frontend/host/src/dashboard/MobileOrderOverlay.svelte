<script lang="ts">
import {untrack} from 'svelte';
import {hostT} from '../services/host-i18n.svelte.js';

interface OrderCard {
  id: string;
  label: string;
}

interface Props {
  cards: OrderCard[];
  onCommit: (order: string[]) => void;
  close: (result: undefined) => void;
}

let {cards, onCommit, close}: Props = $props();
let draft = $state<OrderCard[]>(
  untrack(() => cards.map((card) => ({...card}))),
);
let dragIndex: number | null = $state(null);
let cardRefs: HTMLElement[] = $state([]);

function commit(): void {
  onCommit(draft.map((card) => card.id));
  close(undefined);
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

<div class="mndw-order-overlay">
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
        >
          <mndw-icon name="menu"></mndw-icon>
        </span>
        <span class="mndw-order-card__label">{card.label}</span>
        <span class="mndw-order-card__moves">
          <mndw-button
            variant="ghost"
            onclick={() => move(index, -1)}
            disabled={index === 0}
            aria-label={hostT('dashboard.move-up', {label: card.label})}
          >
            <mndw-icon name="arrow-up"></mndw-icon>
          </mndw-button>
          <mndw-button
            variant="ghost"
            onclick={() => move(index, 1)}
            disabled={index === draft.length - 1}
            aria-label={hostT('dashboard.move-down', {label: card.label})}
          >
            <mndw-icon name="arrow-down"></mndw-icon>
          </mndw-button>
        </span>
      </li>
    {/each}
  </ul>
  <div class="mndw-order-overlay__actions">
    <mndw-button
      variant="primary"
      onclick={commit}
    >{hostT('common.save')}</mndw-button>
  </div>
</div>
