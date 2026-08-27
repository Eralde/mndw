<script lang="ts">
type Row = {name: string};

type Props = {row: Row; value: string; colId: string};

let {row, value, colId}: Props = $props();
</script>

<span
  class="test-cell"
  data-col={colId}
>{value} <strong>{row.name}</strong></span>

<style>
.test-cell {
  color: rgb(255, 0, 0);
  font-weight: 700;
}
</style>
