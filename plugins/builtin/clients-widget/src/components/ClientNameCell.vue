<script setup lang="ts">
  import type {ClientRecord} from '../services/clients.js';
  import type {ClientNameView, LinkStatusView} from './cell-views.js';

  defineOptions({inheritAttrs: false});

  interface Props {
    row: ClientRecord;
    value: ClientNameView;
    colId: string;
  }

  const props = defineProps<Props>();

  const TONE_CLASS: Record<LinkStatusView['tone'], string> = {
    up: 'clients-table__dot--up',
    down: 'clients-table__dot--down',
    unavailable: 'clients-table__dot--unavailable',
  };
</script>

<template>
  <span class="client-name-cell">
    <span
      class="clients-table__status-indicator"
      :class="TONE_CLASS[props.value.link.tone]"
      role="img"
      :title="props.value.link.label"
    >
      <span class="clients-table__sr-only">{{ props.value.link.label }}</span>
    </span>
    <span class="client-name">{{ props.value.displayName }}</span>
  </span>
</template>

<style scoped>
.client-name-cell {
  display: inline-flex;
  align-items: center;
  gap: var(--mndw-space-2);
}

.client-name {
  font-weight: var(--mndw-weight-semibold);
}

.clients-table__status-indicator {
  display: inline-block;
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 50%;
}

.clients-table__dot--up {
  background: var(--mndw-success);
}

.clients-table__dot--down {
  background: var(--mndw-danger);
}

.clients-table__dot--unavailable {
  background: var(--mndw-text-subtle);
}

.clients-table__sr-only {
  position: absolute;
  inline-size: 0;
  block-size: 0;
  overflow: hidden;
  margin: 0;
  padding: 0;
  border: 0;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
