<script lang="ts">
import {onMount} from 'svelte';
import {svelteCellLifecycle} from './stateful-cell-lifecycle.js';

type Row = {name: string};
type Props = {row: Row; value: string; colId: string};

let {row, value, colId}: Props = $props();
let count = $state(0);
svelteCellLifecycle.created += 1;

onMount(() => {
  svelteCellLifecycle.mounted += 1;
  return () => {
    svelteCellLifecycle.destroyed += 1;
  };
});
</script>

<button
  class="stateful-cell"
  onclick={() => {
    count += 1;
  }}
>
  {count}|{value}|{row.name}|{colId}
</button>
