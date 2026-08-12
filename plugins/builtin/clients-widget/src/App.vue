<script setup lang="ts">
import type {PluginContext} from '@mndw/sdk';
import {useTranslator} from '@mndw/sdk/vue';
import type {MndwCheckboxChangeDetail} from '@mndw/ui';
import {computed, onMounted, onUnmounted, ref} from 'vue';
import ClientsTable from './components/ClientsTable.vue';
import {type ClientRecord, fetchClients, filterVisibleClients} from './services/clients.js';
import {openSettingsDialog} from './services/open-settings-dialog.js';
import {createRefreshLoop, type RefreshLoop} from '@mndw/sdk/refresh';

const props = defineProps<{ctx: PluginContext}>();

const COLUMN_KEYS = ['ip', 'connection', 'uptime', 'lastSeen'] as const;
const KEY_COLUMNS = 'column-visibility';
const KEY_OFFLINE = 'show-offline';
const KEY_INTERVAL = 'refresh-interval';
const DEFAULT_INTERVAL_SECONDS = 3;

const allClients = ref<ClientRecord[]>([]);
const error = ref<string | null>(null);
const showOffline = ref(false);
const refreshIntervalSeconds = ref(DEFAULT_INTERVAL_SECONDS);
const columnVisibility = ref<Record<string, boolean>>(
  Object.fromEntries(COLUMN_KEYS.map((key) => [key, true])),
);
const loading = ref(true);
const hasSuccessfulFetch = ref(false);
const dirty = new Set<string>();
const translator = useTranslator(props.ctx.i18n);
const t = (key: string): string => translator.t(key);

let refreshLoop: RefreshLoop | null = null;

const visibleClients = computed(() => filterVisibleClients(allClients.value, showOffline.value));
const headerLabel = computed(() => {
  return hasSuccessfulFetch.value
    ? `${t('title')} (${visibleClients.value.length})`
    : t('title');
});

function persist(key: string, value: string): void {
  dirty.add(key);
  void props.ctx.storage.set(key, value).catch((caught: unknown) => {
    console.warn('[clients-widget] could not persist', key, caught);
  });
}

function onColumnChange(key: string, value: boolean): void {
  columnVisibility.value = {...columnVisibility.value, [key]: value};
  persist(KEY_COLUMNS, JSON.stringify(columnVisibility.value));
}

function onOfflineChange(event: CustomEvent<MndwCheckboxChangeDetail>): void {
  showOffline.value = event.detail.checked;
  persist(KEY_OFFLINE, String(showOffline.value));
}

function onIntervalChange(value: number): void {
  refreshIntervalSeconds.value = value;
  persist(KEY_INTERVAL, String(value));
  refreshLoop?.setIntervalMs(value * 1000);
}

function openSettings(): void {
  openSettingsDialog(
    props.ctx,
    columnVisibility.value,
    refreshIntervalSeconds.value,
    onColumnChange,
    onIntervalChange,
    translator,
  );
}

function applyStoredColumns(raw: string): void {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[clients-widget] ignoring malformed column-visibility');

    return;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn('[clients-widget] ignoring non-object column-visibility');

    return;
  }

  const merged = {...columnVisibility.value};

  for (const key of COLUMN_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];

    if (typeof value === 'boolean') {
      merged[key] = value;
    }
  }

  columnVisibility.value = merged;
}

function applyStoredOffline(raw: string): void {
  if (raw !== 'true' && raw !== 'false') {
    console.warn('[clients-widget] ignoring malformed show-offline');

    return;
  }

  showOffline.value = raw === 'true';
}

function applyStoredInterval(raw: string): void {
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    console.warn('[clients-widget] ignoring malformed refresh-interval');

    return;
  }

  refreshIntervalSeconds.value = parsed;
  refreshLoop?.setIntervalMs(parsed * 1000);
}

function restore(key: string, apply: (raw: string) => void): void {
  void props.ctx.storage.get(key).then((raw) => {
    if (raw !== null && !dirty.has(key)) {
      apply(raw);
    }
  }).catch((caught: unknown) => {
    console.warn('[clients-widget] could not read', key, caught);
  });
}

onMounted(() => {
  refreshLoop = createRefreshLoop({
    load: () => fetchClients(props.ctx.rciManager),
    intervalMs: refreshIntervalSeconds.value * 1000,
    onSuccess: (clients) => {
      allClients.value = clients;
      error.value = null;
      loading.value = false;
      hasSuccessfulFetch.value = true;
    },
    onError: (caught, isInitial) => {
      if (isInitial && !hasSuccessfulFetch.value) {
        error.value = caught instanceof Error ? caught.message : String(caught);
        loading.value = false;

        return;
      }

      console.warn('[clients-widget] refresh failed', caught);
    },
  });

  refreshLoop.start();

  restore(KEY_COLUMNS, applyStoredColumns);
  restore(KEY_OFFLINE, applyStoredOffline);
  restore(KEY_INTERVAL, applyStoredInterval);
});

onUnmounted(() => {
  refreshLoop?.stop();
  refreshLoop = null;
});
</script>

<template>
  <div class="clients-widget">
    <header class="clients-widget__header">
      <span>{{ headerLabel }}</span>
      <span data-testid="l10n-probe" hidden>{{ translator.t('l10n.probe') }}</span>
      <mndw-checkbox
        class="clients-widget__toggle"
        :checked="showOffline"
        @mndwchange="onOfflineChange"
      >
        {{ t('show-offline') }}
      </mndw-checkbox>
      <mndw-button variant="ghost" :aria-label="t('settings')" @click="openSettings">⚙</mndw-button>
    </header>
    <ClientsTable
      :clients="visibleClients"
      :column-visibility="columnVisibility"
      :error="error"
      :loading="loading"
      :show-offline="showOffline"
      :translator="translator"
    />
  </div>
</template>

<style scoped>
.clients-widget {
  display: grid;
  gap: var(--mndw-space-2);
  height: 100%;
  min-height: 0;
  overflow: auto;
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

.clients-widget__header {
  display: flex;
  position: sticky;
  top: 0;
  z-index: 1;
  gap: var(--mndw-space-3);
  align-items: center;
  background: var(--mndw-surface);
  box-sizing: border-box;
  height: var(--mndw-control-h);
  padding: var(--mndw-space-1) 0;
  font-size: var(--mndw-text-sm);
}

.clients-widget__toggle {
  display: flex;
  gap: var(--mndw-space-1);
  align-items: center;
  margin-left: auto;
}
</style>
