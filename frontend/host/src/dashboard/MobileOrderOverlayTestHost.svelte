<script lang="ts">
import MobileOrderOverlay from './MobileOrderOverlay.svelte';

interface Card {
  id: string;
  label: string;
}

interface Props {
  cards: Card[];
  onCommit: (order: string[]) => void;
}

let {cards, onCommit}: Props = $props();
let open = $state(true);

export function close(): void {
  open = false;
}

export function reopen(nextCards: Card[]): void {
  cards = nextCards;
  open = true;
}
</script>

<MobileOrderOverlay
  {open}
  {cards}
  {onCommit}
/>
