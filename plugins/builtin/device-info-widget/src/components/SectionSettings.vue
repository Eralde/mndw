<script setup lang="ts">
import type {Translator} from '@mndw/sdk';
import type {MndwCheckboxChangeDetail} from '@mndw/ui';

interface Props {
  visibility: Record<string, boolean>;
  onChange: (key: string, value: boolean) => void;
  translator: Translator;
}

const props = defineProps<Props>();

const SECTIONS: readonly {key: string; label: string}[] = [
  {key: 'cpu', label: 'cpu'},
  {key: 'ram', label: 'ram'},
  {key: 'identity', label: 'identity'},
];

function onToggle(key: string, event: CustomEvent<MndwCheckboxChangeDetail>): void {
  props.onChange(key, event.detail.checked);
}
</script>

<template>
  <div class="device-info-settings">
    <fieldset class="device-info-settings__group">
      <legend>{{ props.translator.t('sections') }}</legend>
      <mndw-checkbox
        v-for="section in SECTIONS"
        :key="section.key"
        class="device-info-settings__row"
        :checked="visibility[section.key] !== false"
        @mndwchange="onToggle(section.key, $event)"
      >
        {{ props.translator.t(section.label) }}
      </mndw-checkbox>
    </fieldset>
  </div>
</template>

<style scoped>
.device-info-settings {
  display: grid;
  gap: var(--mndw-space-3);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
}

.device-info-settings__group {
  display: grid;
  gap: var(--mndw-space-2);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
  padding: var(--mndw-space-3);
}

.device-info-settings__row {
  display: flex;
  gap: var(--mndw-space-2);
  align-items: center;
}
</style>
