<script setup lang="ts">
import type {ClientRecord} from '../services/clients.js';
import {DASH, type ConnectionView} from './cell-views.js';

defineOptions({inheritAttrs: false});

interface Props {
  row: ClientRecord;
  value: ConnectionView;
  colId: string;
}

const props = defineProps<Props>();
</script>

<template>
  <template v-if="props.value.kind === 'none'">{{ DASH }}</template>
  <template v-else-if="props.value.kind === 'wireless'">{{ props.value.text }}</template>
  <template v-else>
    {{ props.value.speed }}<br>
    {{ props.value.port }}
  </template>
</template>
