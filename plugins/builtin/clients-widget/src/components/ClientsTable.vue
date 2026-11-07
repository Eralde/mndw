<script setup lang="ts">
import {computed} from 'vue';
import type {Translator} from '@mndw/sdk';
import type {ClientRecord} from '../services/clients.js';
import {buildColumns} from './columns.js';

interface Props {
  clients: ClientRecord[];
  columnVisibility: Record<string, boolean>;
  error: string | null;
  loading: boolean;
  showOffline: boolean;
  translator: Translator;
}

const HIDEABLE_COLUMNS = ['ip', 'connection', 'uptime', 'lastSeen'] as const;

const props = defineProps<Props>();

const columns = computed(() => buildColumns(props.translator));
const hiddenColumns = computed(() =>
  HIDEABLE_COLUMNS.filter((key) => props.columnVisibility[key] === false)
);
const emptyMessage = computed(() =>
  props.showOffline ? props.translator.t('empty.found') : props.translator.t('empty.connected')
);
</script>

<template>
  <p v-if="loading && clients.length === 0" class="clients-table__status" role="status">
    {{ props.translator.t('loading') }}
  </p>
  <div v-else-if="error !== null" class="mndw-alert mndw-alert--danger" role="alert">
    {{ props.translator.t('error') }}: {{ error }}
  </div>
  <p v-else-if="clients.length === 0" class="clients-table__status" role="status">
    {{ emptyMessage }}
  </p>
  <mndw-table
    v-else
    class="clients-table"
    layout="auto"
    min-width="36rem"
    sticky-header
    :columns.prop="columns"
    :rows.prop="clients"
    :rowKey.prop="'mac'"
    :hiddenColumns.prop="hiddenColumns"
    :columnMenu.prop="false"
  />
</template>

<style scoped>
.clients-table__status {
  margin: 0;
  color: var(--mndw-text-muted);
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
}

/* Fill the widget height and clip wide content inside the bordered, scrollable
   viewport (width/height 100%, min-*: 0, overflow:auto, border, radius-lg).
   Filling height also gives the built-in `sticky-header` a bounded viewport to scroll within.
   The sticky header comes from the `sticky-header` attribute (not ::part), which
   also bumps the pinned header corner to the correct z-index; a manual
   ::part(header-cell){z-index} rule would win over the internal .pinned z-index
   in the parts cascade and mis-stack the top-left corner during scroll. The
   sticky-left name column and its border separator come from the column's
   sticky: 'start'; there is no per-column part, so no box-shadow hook. */
.clients-table {
  display: block;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.clients-table::part(viewport) {
  height: 100%;
  min-height: 0;
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-lg);
}
</style>
