<script setup lang="ts">
interface Props {
  visibility: Record<string, boolean>;
  refreshIntervalSeconds: number;
  onChange: (key: string, value: boolean) => void;
  onRefreshIntervalChange: (value: number) => void;
}

const props = defineProps<Props>();

const COLUMNS: readonly {key: string; label: string}[] = [
  {key: 'ip', label: 'IP Address'},
  {key: 'interface', label: 'Interface'},
  {key: 'speed', label: 'Speed'},
  {key: 'uptime', label: 'Uptime'},
  {key: 'lastSeen', label: 'Last Seen'},
];

function onToggle(key: string, event: Event): void {
  props.onChange(key, (event.target as HTMLInputElement).checked);
}

function onInterval(event: Event): void {
  props.onRefreshIntervalChange(Number.parseInt((event.target as HTMLInputElement).value, 10));
}
</script>

<template>
  <div class="clients-settings">
    <fieldset class="clients-settings__group">
      <legend>Columns</legend>
      <label
        v-for="column in COLUMNS"
        :key="column.key"
        class="clients-settings__row"
      >
        <input
          type="checkbox"
          :checked="visibility[column.key] !== false"
          @change="onToggle(column.key, $event)"
        >
        {{ column.label }}
      </label>
    </fieldset>

    <div class="clients-settings__group">
      <label class="clients-settings__row" for="clients-refresh-interval">
        Refresh interval
      </label>
      <input
        id="clients-refresh-interval"
        type="range"
        min="1"
        max="10"
        step="1"
        :value="refreshIntervalSeconds"
        @input="onInterval"
      >
      <span class="clients-settings__value">{{ refreshIntervalSeconds }}s</span>
    </div>
  </div>
</template>

<style scoped>
.clients-settings {
  display: grid;
  gap: var(--mndw-space-3);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
}

.clients-settings__group {
  display: grid;
  gap: var(--mndw-space-2);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
  padding: var(--mndw-space-3);
}

.clients-settings__row {
  display: flex;
  gap: var(--mndw-space-2);
  align-items: center;
}

.clients-settings__value {
  color: var(--mndw-text-muted);
}
</style>
