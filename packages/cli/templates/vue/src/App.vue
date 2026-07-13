<script setup lang="ts">
import type {PluginContext} from '@mndw/sdk';

const {ctx} = defineProps<{ctx: PluginContext}>();
</script>

<template>
  <div class="wrap">
    <h3 class="title">__MNDW_LABEL__</h3>
    <p class="device">Device: {{ ctx.hostInfo.deviceName }}</p>
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
