<script lang="ts">
interface TableRow {
  id: string;
  name: string;
}

let {value}: {row: TableRow; value: string; colId: string} = $props();
</script>

<span data-testid="table-name-cell">{value}</span>
