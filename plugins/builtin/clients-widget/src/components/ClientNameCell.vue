<script setup lang="ts">
  import type {ClientRecord} from '../services/clients.js';

  defineOptions({inheritAttrs: false});

  interface Props {
    row: ClientRecord;
    value: string;
    colId: string;
  }

  defineProps<Props>();
</script>

<template>
  <span class="client-name">{{ value }}</span>
</template>

<style scoped>
.client-name {
  font-weight: var(--mndw-weight-semibold);
}
</style>