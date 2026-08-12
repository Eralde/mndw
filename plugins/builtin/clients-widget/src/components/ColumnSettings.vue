<script setup lang="ts">
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
  props.onRefreshIntervalChange(event.detail.value);
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
        :value-text="`${refreshIntervalSeconds}s`"
        @mndwinput="onInterval"
        ></mndw-slider>
      </mndw-field>
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
