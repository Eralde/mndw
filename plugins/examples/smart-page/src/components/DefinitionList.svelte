<script
  lang="ts"
  module
>
export interface Row {
  key: string;
  label: string;
  value: string;
  /** Marks a value that needs attention; `warningLabel` says so for readers who do not see the color. */
  warning?: boolean;
  testId?: string;
}
</script>

<script lang="ts">
interface Props {
  rows: readonly Row[];
  warningLabel?: string;
}

let {rows, warningLabel = ''}: Props = $props();
</script>

<dl>
  {#each rows as row (row.key)}
    <dt>{row.label}</dt>
    <dd class:warning={row.warning === true}>
      <span data-testid={row.testId}>{
        row.value
      }</span>{#if row.warning === true}<span class="visually-hidden">{
          ` ${warningLabel}`
        }</span>{/if}
    </dd>
  {/each}
</dl>

<style>
/* Every card that holds one is a size container: the pairs stack by the card's width, not the viewport's, because the
   page sits beside the host sidebar. */
dl {
  display: grid;
  grid-template-columns: fit-content(14rem) minmax(0, 1fr);
  gap: var(--mndw-space-1) var(--mndw-space-3);
  margin: 0;
}

dt {
  color: var(--mndw-text-muted);
}

dd {
  position: relative;
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}

dd.warning {
  color: var(--mndw-warning);
}

.visually-hidden {
  position: absolute;
  overflow: hidden;
  clip-path: inset(50%);
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  white-space: nowrap;
}

@container (width < 30rem) {
  dl {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }

  dd:not(:last-child) {
    margin-bottom: var(--mndw-space-2);
  }
}
</style>
