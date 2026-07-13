<script setup lang="ts">
import type {PluginContext} from '@mndw/sdk';
import {computed, onMounted, ref} from 'vue';

import CopyField from './components/CopyField.vue';
import {type DeviceInfo, fetchDeviceInfo, formatUptime} from './services/device-info.js';

const props = defineProps<{ctx: PluginContext}>();

const loading = ref(true);
const error = ref(false);
const info = ref<DeviceInfo | null>(null);

const firmware = computed(() => props.ctx.hostInfo.firmwareVersion);
const deviceName = computed(() => props.ctx.hostInfo.deviceName);
const uptime = computed(() =>
  info.value !== null && info.value.uptimeSeconds !== null
    ? formatUptime(info.value.uptimeSeconds)
    : 'Unknown');

onMounted(async () => {
  try {
    info.value = await fetchDeviceInfo(props.ctx.rciManager);
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="app">
    <div v-if="loading" class="app__loading">Loading&#8230;</div>
    <div v-else-if="error || info === null" class="app__error">Failed to load device info</div>
    <div v-else>
      <div class="app__grid">
        <span class="app__label">Device:</span>
        <span class="app__value">{{ deviceName }} ({{ info.model }})</span>
        <span class="app__label">Firmware:</span>
        <span class="app__value">{{ firmware }}</span>
        <span class="app__label">Uptime:</span>
        <span class="app__value">{{ uptime }}</span>
      </div>
      <hr class="app__divider">
      <div class="app__grid">
        <CopyField label="Serial" :value="info.serial" />
        <CopyField label="Service Tag" :value="info.serviceTag" />
        <CopyField label="MAC" :value="info.mac" />
        <CopyField label="HW ID" :value="info.hwid" />
        <CopyField label="CID" :value="info.cid" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  padding: 16px;
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: 13px;
}

.app__loading {
  padding: 16px;
  color: var(--mndw-text-subtle);
}

.app__error {
  padding: 16px;
  color: var(--mndw-danger);
}

.app__grid {
  display: flex;
  flex-direction: column;
  gap: 4px 12px;
  align-items: baseline;
}

.app__label {
  color: var(--mndw-text-subtle);
  font-weight: 600;
  white-space: nowrap;
}

.app__value {
  color: var(--mndw-text);
  overflow-wrap: anywhere;
}

.app__divider {
  border: none;
  border-top: 1px solid var(--mndw-border);
  margin: 12px 0;
}
</style>
