<script setup lang="ts">
import {computed} from 'vue';
import type {ClientRecord, WifiBand} from '../services/clients.js';
import {formatCompactDuration, formatElapsed, formatFullDuration} from '../services/format-duration.js';

interface Props {
  clients: ClientRecord[];
  columnVisibility: Record<string, boolean>;
  error: string | null;
  loading: boolean;
  showOffline: boolean;
}

const props = defineProps<Props>();
const DASH = '—';
const shows = (key: string): boolean => props.columnVisibility[key] !== false;
const emptyMessage = computed(() => props.showOffline ? 'No clients found' : 'No clients connected');

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
  return port === null || port === undefined || port === '' || port === 'undefined' ? DASH : `Port ${port}`;
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
    Loading clients…
  </p>
  <div v-else-if="error !== null" class="mndw-alert mndw-alert--danger" role="alert">
    show device-list failed: {{ error }}
  </div>
  <p v-else-if="clients.length === 0" class="clients-table__status" role="status">
    {{ emptyMessage }}
  </p>
  <table v-else class="clients-table">
    <thead>
    <tr>
      <th scope="col">Name</th>
      <th scope="col">Link</th>
      <th v-if="shows('ip')" scope="col">IP Address</th>
      <th v-if="shows('connection')" scope="col">Connection</th>
      <th v-if="shows('uptime')" scope="col">Uptime</th>
      <th v-if="shows('lastSeen')" scope="col">Last Seen</th>
    </tr>
    </thead>
    <tbody>
    <tr v-for="client in clients" :key="client.mac">
      <td>{{ client.displayName }}</td>
      <td>
        <template v-if="client.link === null">{{ DASH }}</template>
        <template v-else>
            <span
                class="clients-table__dot"
                :class="client.link === 'up' ? 'clients-table__dot--up' : 'clients-table__dot--down'"
            />
          {{ client.link }}
        </template>
      </td>
      <td v-if="shows('ip')">{{ client.ip ?? DASH }}</td>
      <td v-if="shows('connection')">
        <template v-if="client.connectionType === 'unknown' || client.connection === null">{{ DASH }}</template>
        <template v-else-if="'accessPointId' in client.connection">
          RSSI: {{ client.connection.rssi }}; {{ client.connection.txrate }} Mbps;
          {{ wirelessBandsText(client.connection.bands) }}
        </template>
        <template v-else>
          {{ wiredSpeedText(client.connection.speed) }}<br>
          {{ wiredPortText(client.connection.port) }}
        </template>
      </td>
      <td v-if="shows('uptime')" :title="fullText(client.uptime)">{{ durationText(client.uptime) }}</td>
      <td v-if="shows('lastSeen')" :title="fullText(client.lastSeen)">{{ elapsedText(client.lastSeen) }}</td>
    </tr>
    </tbody>
  </table>
</template>

<style scoped>
.clients-table {
  width: 100%;
  border-collapse: collapse;
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
}

.clients-table thead {
  position: sticky;
  top: var(--mndw-control-h);
  z-index: 1;
  background: var(--mndw-surface);
}

.clients-table th {
  position: sticky;
  top: var(--mndw-control-h);
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

.clients-table__dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: var(--mndw-space-1);
}

.clients-table__dot--up {
  background: var(--mndw-success);
}

.clients-table__dot--down {
  background: var(--mndw-danger);
}

.clients-table__status {
  margin: 0;
  color: var(--mndw-text-muted);
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
}
</style>
