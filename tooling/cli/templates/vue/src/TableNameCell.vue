<script setup lang="ts">
interface TableRow {
  id: string;
  name: string;
}

defineProps<{row: TableRow; value: string; colId: string}>();
</script>

<template>
  <span data-testid="table-name-cell">{{ value }}</span>
</template>
