<script setup lang="ts">
import {computed, ref, watchEffect} from 'vue';
import type {PluginContext} from '@mndw/sdk';
import {column, type MndwTableProps} from '@mndw/ui';
import {useTheme, useTranslator} from '@mndw/sdk/vue';
import {vueCell} from '@mndw/ui-vue';
import TableNameCell from './TableNameCell.vue';

interface TableRow {
  id: string;
  name: string;
}

const {ctx} = defineProps<{ctx: PluginContext}>();
const translator = useTranslator(ctx.i18n);
const theme = useTheme(ctx);
const rows = computed<TableRow[]>(() => [
  {id: 'first', name: translator.t('table.first')},
  {id: 'second', name: translator.t('table.second')},
]);
const columns = computed(() => [
  column<TableRow>()({
    id: 'name',
    label: translator.t('table.column'),
    accessor: (row) => row.name,
    renderer: vueCell<TableRow, string>()(TableNameCell),
  }),
]);
const table = ref<(HTMLElement & MndwTableProps<TableRow>) | null>(null);

watchEffect(() => {
  if (table.value === null) {
    return;
  }

  Object.assign(table.value, {
    columns: columns.value,
    rows: rows.value,
    rowKey: 'id',
    caption: translator.t('table.caption'),
    columnMenu: false,
  });
});
</script>

<template>
  <div class="wrap" :data-theme="theme">
    <h3 class="title" data-testid="l10n-probe" data-plugin-label="__MNDW_LABEL__">{{ translator.t('l10n.probe') }}</h3>
    <p class="device">Device: {{ ctx.deviceInfo.deviceName }}</p>
    <p class="result">{{ translator.t('l10n.result') }}</p>
    <mndw-table
      ref="table"
      :columns.prop="columns"
      :rows.prop="rows"
      :rowKey.prop="'id'"
      :caption.prop="translator.t('table.caption')"
      :columnMenu.prop="false"
    />
  </div>
</template>

<style scoped>
.wrap {
  padding: var(--mndw-space-4);
  font-family: var(--mndw-font-sans);
  color: var(--mndw-text);
  background: var(--mndw-surface);
}

.title {
  margin: 0 0 var(--mndw-space-2);
  font-size: var(--mndw-text-lg);
  font-weight: var(--mndw-weight-semibold);
}

.device {
  margin: 0;
  color: var(--mndw-text-muted);
}
</style>
