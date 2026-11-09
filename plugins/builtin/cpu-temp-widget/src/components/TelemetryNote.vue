<script setup lang="ts">
import {computed, inject} from 'vue';
import type {HostNavigation, PluginI18n} from '@mndw/sdk';
import {useTranslator} from '@mndw/sdk/vue';

const props = defineProps<{
  sessionConfigured: boolean;
  lastPointTime: string | null;
  navigation: HostNavigation;
}>();

const i18n = inject<PluginI18n>('mndw:plugin-i18n');

if (i18n === undefined) {
  throw new Error('TelemetryNote requires plugin i18n to be provided');
}

const translator = useTranslator(i18n);
const target = {kind: 'settings', tab: 'general'} as const;
const href = computed(() => props.navigation.href(target));
const message = computed(() => {
  if (!props.sessionConfigured) {
    return translator.t('telemetry-note.no-session');
  }

  if (props.lastPointTime !== null) {
    return translator.t('telemetry-note.off-with-data', {time: props.lastPointTime});
  }

  return translator.t('telemetry-note.off');
});

const linkLabel = computed(() => {
  return translator.t(props.sessionConfigured ? 'telemetry-note.link' : 'telemetry-note.session-link');
});

const navigate = (event: MouseEvent): void => {
  if (props.navigation.navigate(target)) {
    event.preventDefault();
  }
};
</script>

<template>
  <p class="telemetry-note" role="status">
    {{ message }}
    <a v-if="href !== undefined" :href="href" @click="navigate">{{ linkLabel }}</a>
  </p>
</template>

<style scoped>
.telemetry-note {
  margin: 0 0 0.5rem;
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.telemetry-note a {
  color: inherit;
  font-weight: 600;
}
</style>
