<script setup lang="ts">
import type {ClientRecord} from '../services/clients.js';
import type {TitledText} from './cell-views.js';

defineOptions({inheritAttrs: false});

interface Props {
  row: ClientRecord;
  value: TitledText;
  colId: string;
}

const props = defineProps<Props>();
</script>

<template>
  <span class="titled-text" :title="props.value.title">{{ props.value.text }}</span>
</template>
