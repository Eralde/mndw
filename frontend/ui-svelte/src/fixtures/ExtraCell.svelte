<script lang="ts">
type Row = {name: string};

type Props = {
  row: Row;
  value: string;
  colId: string;
  label: string;
  onPing: () => void;
};

let {row, value, colId, label, onPing}: Props = $props();
</script>

<button
  class="extra-cell"
  data-col={colId}
  onclick={onPing}
>
  {label}:{value}:{row.name}
</button>
