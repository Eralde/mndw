<script setup lang="ts">
import {computed} from 'vue';
import type {Translator} from '@mndw/sdk';
import type {ClientRecord, WifiBand} from '../services/clients.js';
import {formatCompactDuration, formatElapsed, formatFullDuration} from '../services/format-duration.js';
import ClientNameCell from './ClientNameCell.vue';

interface Props {
  clients: ClientRecord[];
  columnVisibility: Record<string, boolean>;
  error: string | null;
  loading: boolean;
  showOffline: boolean;
  translator: Translator;
}

const props = defineProps<Props>();
const DASH = '—';
const shows = (key: string): boolean => props.columnVisibility[key] !== false;
const emptyMessage = computed(() => {
  return props.showOffline ? props.translator.t('empty.found') : props.translator.t('empty.connected');
});

function bandText(band: WifiBand): string {
  return `${band === '2' ? '2.4' : band} GHz`;
}

function wirelessBandsText(bands: WifiBand[]): string {
  return bands.length === 0 ? DASH : bands.map((band) => bandText(band)).join(', ');
}

function wiredSpeedText(speed: number | null | undefined): string {
  return speed === undefined || !Number.isFinite(speed) ? DASH : `${speed} Mbps`;
}

function wiredPortText(port: string | null | undefined): string {
  return port === null || port === undefined || port === '' || port === 'undefined'
    ? DASH
    : `${props.translator.t('port')} ${port}`;
}

function durationText(seconds: number | null): string {
  return seconds === null ? DASH : formatCompactDuration(seconds);
}

function elapsedText(seconds: number | null): string {
  return seconds === null ? DASH : formatElapsed(seconds);
}

function fullText(seconds: number | null): string | undefined {
  return seconds === null ? undefined : formatFullDuration(seconds);
}
</script>

<template>
  <p v-if="loading && clients.length === 0" class="clients-table__status" role="status">
    {{ props.translator.t('loading') }}
  </p>
  <div v-else-if="error !== null" class="mndw-alert mndw-alert--danger" role="alert">
    {{ props.translator.t('error') }}: {{ error }}
  </div>
  <p v-else-if="clients.length === 0" class="clients-table__status" role="status">
    {{ emptyMessage }}
  </p>
  <div v-else class="clients-table__surface">
    <div class="mndw-table-viewport clients-table__viewport">
      <table class="clients-table">
        <thead>
        <tr>
          <th class="clients-table__sticky-column" scope="col">{{ props.translator.t('column.name') }}</th>
          <th scope="col">{{ props.translator.t('column.link') }}</th>
          <th v-if="shows('ip')" scope="col">{{ props.translator.t('column.ip') }}</th>
          <th v-if="shows('connection')" scope="col">{{ props.translator.t('column.connection') }}</th>
          <th v-if="shows('uptime')" scope="col">{{ props.translator.t('column.uptime') }}</th>
          <th v-if="shows('lastSeen')" scope="col">{{ props.translator.t('column.last-seen') }}</th>
        </tr>
        </thead>
        <tbody>
        <tr v-for="client in clients" :key="client.mac">
          <td class="clients-table__sticky-column">
        <ClientNameCell
          :row="client"
          :value="client.displayName"
          col-id="name"
        />
          </td>
          <td>
            <span
              class="clients-table__status-indicator"
              :class="client.link === 'up'
                ? 'clients-table__dot--up'
                : client.link === 'down'
                ? 'clients-table__dot--down'
                : 'clients-table__dot--unavailable'"
              role="img"
              :title="client.link === 'up'
                ? props.translator.t('link.online')
                : client.link === 'down'
                ? props.translator.t('link.offline')
                : props.translator.t('link.unavailable')"
            >
              <span class="clients-table__sr-only">{{ client.link === 'up'
                ? props.translator.t('link.online')
                : client.link === 'down'
                ? props.translator.t('link.offline')
                : props.translator.t('link.unavailable') }}</span>
            </span>
          </td>
          <td v-if="shows('ip')">{{ client.ip ?? DASH }}</td>
          <td v-if="shows('connection')">
            <template v-if="client.connectionType === 'unknown' || client.connection === null">{{ DASH }}</template>
            <template v-else-if="'accessPointId' in client.connection">
              {{ props.translator.t('rssi') }}: {{ client.connection.rssi }}; {{ client.connection.txrate }} Mbps;
              {{ wirelessBandsText(client.connection.bands) }}
            </template>
            <template v-else>
              {{ wiredSpeedText(client.connection.speed) }}<br>
              {{ wiredPortText(client.connection.port) }}
            </template>
          </td>
          <td v-if="shows('uptime')" class="clients-table__nowrap" :title="fullText(client.uptime)">
            {{ durationText(client.uptime) }}
          </td>
          <td v-if="shows('lastSeen')" class="clients-table__nowrap" :title="fullText(client.lastSeen)">
            {{ elapsedText(client.lastSeen) }}
          </td>
        </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.clients-table__surface {
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.clients-table__viewport {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-lg);
}

.clients-table {
  width: max-content;
  min-width: 44rem;
  border-collapse: collapse;
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
}

.clients-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--mndw-surface);
}

.clients-table th {
  position: sticky;
  top: 0;
  border-bottom: 1px solid var(--mndw-border);
  padding: var(--mndw-space-1) var(--mndw-space-2);
  background: var(--mndw-surface);
  color: var(--mndw-text-muted);
  font-weight: var(--mndw-weight-semibold);
  text-align: left;
}

.clients-table td {
  border-bottom: 1px solid var(--mndw-border);
  padding: var(--mndw-space-1) var(--mndw-space-2);
}

.clients-table__sticky-column {
  position: sticky !important;
  left: 0;
  z-index: 2;
  min-width: 12rem;
  background: var(--mndw-surface);
  box-shadow: 1px 0 0 var(--mndw-border);
}

.clients-table th.clients-table__sticky-column {
  z-index: 3;
  background: var(--mndw-surface);
}

.clients-table__status-indicator {
  display: inline-block;
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 50%;
}

.clients-table__dot--up {
  background: var(--mndw-success);
}

.clients-table__dot--down {
  background: var(--mndw-danger);
}

.clients-table__dot--unavailable {
  background: var(--mndw-text-subtle);
}

.clients-table__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  margin: -1px;
  padding: 0;
  border: 0;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.clients-table__nowrap {
  white-space: nowrap;
}

.clients-table__status {
  margin: 0;
  color: var(--mndw-text-muted);
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
}
</style>
