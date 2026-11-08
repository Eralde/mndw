<script setup lang="ts">
import {ref} from 'vue';
import type {Translator} from '@mndw/sdk';
import type {MndwCheckboxChangeDetail, MndwSliderInputDetail} from '@mndw/ui';

interface Props {
  visibility: Record<string, boolean>;
  refreshIntervalSeconds: number;
  onChange: (key: string, value: boolean) => void;
  onRefreshIntervalChange: (value: number) => void;
  translator: Translator;
}

const props = defineProps<Props>();
const refreshIntervalSeconds = ref(props.refreshIntervalSeconds);

const COLUMNS: readonly {key: string; label: string}[] = [
  {key: 'ip', label: 'column.ip'},
  {key: 'connection', label: 'column.connection'},
  {key: 'uptime', label: 'column.uptime'},
  {key: 'lastSeen', label: 'column.last-seen'},
];

function onToggle(key: string, event: CustomEvent<MndwCheckboxChangeDetail>): void {
  props.onChange(key, event.detail.checked);
}

function onInterval(event: CustomEvent<MndwSliderInputDetail>): void {
  refreshIntervalSeconds.value = event.detail.value;
  props.onRefreshIntervalChange(event.detail.value);
}

function formatRefreshInterval(value: number): string {
  return `${value}s`;
}
</script>

<template>
  <div class="clients-settings">
    <fieldset class="clients-settings__group">
      <legend>{{ props.translator.t('columns') }}</legend>
      <mndw-checkbox
        v-for="column in COLUMNS"
        :key="column.key"
        class="clients-settings__row"
        :checked="visibility[column.key] !== false"
        @mndwchange="onToggle(column.key, $event)"
      >
        {{ props.translator.t(column.label) }}
      </mndw-checkbox>
    </fieldset>

    <div class="clients-settings__group">
      <mndw-field :label="props.translator.t('refresh-interval')">
        <mndw-slider
          min="1"
          max="10"
          step="1"
          :value="refreshIntervalSeconds"
          :valueFormatter.prop="formatRefreshInterval"
          @mndwinput="onInterval"
        ></mndw-slider>
      </mndw-field>
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

</style>
