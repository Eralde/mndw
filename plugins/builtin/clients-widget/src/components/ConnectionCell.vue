<script setup lang="ts">
import type {ClientRecord} from '../services/clients.js';
import {DASH, type ConnectionView} from './cell-views.js';
import type {RssiQuality} from './rssi.js';

defineOptions({inheritAttrs: false});

interface Props {
  row: ClientRecord;
  value: ConnectionView;
  colId: string;
}

const props = defineProps<Props>();

const QUALITY_CLASS: Record<RssiQuality, string> = {
  good: 'connection-cell__rssi--good',
  fair: 'connection-cell__rssi--fair',
  weak: 'connection-cell__rssi--weak',
  unknown: '',
};
</script>

<template>
  <template v-if="props.value.kind === 'none'">{{ DASH }}</template>
  <template v-else-if="props.value.kind === 'wireless'">
    {{ props.value.label }}: <span
      class="connection-cell__rssi"
      :class="QUALITY_CLASS[props.value.quality]"
      :title="props.value.title"
    >{{ props.value.rssi }}</span>; {{ props.value.rate }}
  </template>
  <template v-else>
    {{ props.value.speed }}<br>
    {{ props.value.port }}
  </template>
</template>

<style scoped>
.connection-cell__rssi--good {
  color: var(--mndw-success);
}

.connection-cell__rssi--fair {
  color: var(--mndw-warning);
}

.connection-cell__rssi--weak {
  color: var(--mndw-danger);
}
</style>
