<script setup lang="ts">
import type {PluginContext} from '@mndw/sdk';
import {useTranslator} from '@mndw/sdk/vue';

const {ctx} = defineProps<{ctx: PluginContext}>();
const translator = useTranslator(ctx.i18n);
</script>

<template>
  <div class="wrap">
    <h3 class="title" data-testid="l10n-probe" data-plugin-label="__MNDW_LABEL__">{{ translator.t('l10n.probe') }}</h3>
    <p class="device">Device: {{ ctx.deviceInfo.deviceName }}</p>
    <p class="result">{{ translator.t('l10n.result') }}</p>
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
