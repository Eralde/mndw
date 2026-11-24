<script setup lang="ts">
import {computed, ref} from 'vue';
import type {Translator} from '@mndw/sdk';
import type {MndwCheckboxChangeDetail, MndwInputChangeDetail, MndwSliderInputDetail} from '@mndw/ui';
import {isValidRssiThreshold, RSSI_MAX, RSSI_MIN, type RssiThresholds} from './rssi.js';

interface Props {
  visibility: Record<string, boolean>;
  refreshIntervalSeconds: number;
  rssiThresholds: RssiThresholds;
  onChange: (key: string, value: boolean) => void;
  onRefreshIntervalChange: (value: number) => void;
  onRssiThresholdsChange: (value: RssiThresholds) => void;
  translator: Translator;
}

const props = defineProps<Props>();
const refreshIntervalSeconds = ref(props.refreshIntervalSeconds);
const goodText = ref(String(props.rssiThresholds.good));
const fairText = ref(String(props.rssiThresholds.fair));

const COLUMNS: readonly {key: string; label: string}[] = [
  {key: 'ip', label: 'column.ip'},
  {key: 'connection', label: 'column.connection'},
  {key: 'uptime', label: 'column.uptime'},
  {key: 'lastSeen', label: 'column.last-seen'},
];

const invalidThresholdMessage = computed(() =>
  props.translator.t('rssi-thresholds.invalid', {min: RSSI_MIN, max: RSSI_MAX})
);
const goodValue = computed(() => parseThreshold(goodText.value));
const fairValue = computed(() => parseThreshold(fairText.value));
const goodError = computed(() => {
  if (goodValue.value === null) {
    return invalidThresholdMessage.value;
  }

  return fairValue.value !== null && goodValue.value <= fairValue.value
    ? props.translator.t('rssi-thresholds.order')
    : '';
});
const fairError = computed(() => fairValue.value === null ? invalidThresholdMessage.value : '');

function parseThreshold(text: string): number | null {
  const trimmed = text.trim();

  if (trimmed === '') {
    return null;
  }

  const value = Number(trimmed);

  return isValidRssiThreshold(value) ? value : null;
}

function onToggle(key: string, event: CustomEvent<MndwCheckboxChangeDetail>): void {
  props.onChange(key, event.detail.checked);
}

function onInterval(event: CustomEvent<MndwSliderInputDetail>): void {
  refreshIntervalSeconds.value = event.detail.value;
  props.onRefreshIntervalChange(event.detail.value);
}

function onGoodInput(event: CustomEvent<MndwInputChangeDetail>): void {
  goodText.value = event.detail.value;
  emitThresholds();
}

function onFairInput(event: CustomEvent<MndwInputChangeDetail>): void {
  fairText.value = event.detail.value;
  emitThresholds();
}

function emitThresholds(): void {
  const good = goodValue.value;
  const fair = fairValue.value;

  if (good === null || fair === null || good <= fair) {
    return;
  }

  props.onRssiThresholdsChange({good, fair});
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

    <fieldset class="clients-settings__group">
      <legend>{{ props.translator.t('rssi-thresholds.label') }}</legend>
      <mndw-field :label="props.translator.t('rssi-thresholds.good')" :error="goodError">
        <mndw-input
          type="number"
          :min="RSSI_MIN"
          :max="RSSI_MAX"
          step="1"
          :value="goodText"
          @mndwinput="onGoodInput"
        ></mndw-input>
      </mndw-field>
      <mndw-field :label="props.translator.t('rssi-thresholds.fair')" :error="fairError">
        <mndw-input
          type="number"
          :min="RSSI_MIN"
          :max="RSSI_MAX"
          step="1"
          :value="fairText"
          @mndwinput="onFairInput"
        ></mndw-input>
      </mndw-field>
    </fieldset>
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
