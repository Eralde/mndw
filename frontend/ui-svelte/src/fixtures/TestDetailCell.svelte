<script lang="ts">
type Row = {name: string};
type Props = {row: Row; value: Row; colId: string};

let {row, value, colId}: Props = $props();
</script>

<div
  class="test-detail"
  data-col={colId}
>
  detail for <strong>{row.name}</strong> ({value.name})
</div>
