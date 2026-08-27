<script setup lang="ts">
  defineProps<{row: {name: string}; value: string; colId: string}>();
</script>

<template>
  <span
    class="vue-cell"
    :data-col-id="colId"
  >{{ value }} {{ row.name }}</span>
</template>

<style scoped>
.vue-cell {
  color: rgb(0, 0, 255);
  font-weight: 700;
}
</style>