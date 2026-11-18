<script setup lang="ts">
import {ref} from 'vue';
import type {PluginContext} from '@mndw/sdk';
import {useTranslator} from '@mndw/sdk/vue';

const {ctx} = defineProps<{ctx: PluginContext}>();
const translator = useTranslator(ctx.i18n);
const backendMessage = ref<string | undefined>();
const backendError = ref(false);

const load = async (): Promise<void> => {
  if (ctx.backend === undefined) {
    backendError.value = true;

    return;
  }

  try {
    const response = await ctx.backend.call<{message: string}>('hello', {as: 'json'});
    backendMessage.value = response.message;
    backendError.value = false;
  } catch {
    backendMessage.value = undefined;
    backendError.value = true;
  }
};
</script>

<template>
  <section class="__MNDW_NAME__" :aria-labelledby="ctx.kind === 'page' ? 'plugin-title' : undefined">
    <h2 v-if="ctx.kind === 'page'" id="plugin-title">{{ translator.t('l10n.title') }}</h2>
    <p class="device">Device: {{ ctx.device.info.deviceName }}</p>
    <mndw-button variant="primary" type="button" @click="void load()">
      {{ translator.t('l10n.button') }}
    </mndw-button>
    <p class="result" :role="backendError ? 'alert' : 'status'" aria-live="polite">
      <template v-if="backendError">{{ translator.t('l10n.error') }}</template>
      <template v-else-if="backendMessage !== undefined">
        {{ translator.t('l10n.result') }}: {{ backendMessage }}
      </template>
      <template v-else>{{ translator.t('l10n.result') }}</template>
    </p>
  </section>
</template>

<style scoped>
.__MNDW_NAME__ {
  padding: var(--mndw-space-4);
  font-family: var(--mndw-font-sans);
  color: var(--mndw-text);
  background: var(--mndw-surface);
}

.__MNDW_NAME__ .device {
  margin: 0 0 var(--mndw-space-3);
  color: var(--mndw-text-muted);
}

.__MNDW_NAME__ .result {
  margin-block: var(--mndw-space-3) 0;
}
</style>
