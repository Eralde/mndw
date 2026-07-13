<script setup lang="ts">
import {ref} from 'vue';

const props = defineProps<{label: string; value: string}>();

const copied = ref(false);

const handleCopy = (): void => {
  navigator.clipboard.writeText(props.value)
    .then(() => {
      copied.value = true;
      setTimeout(() => {
        copied.value = false;
      }, 1500);
    })
    .catch((ex: unknown) => {
      console.error('[device-info-widget] clipboard write failed', ex);
    });
};
</script>

<template>
  <span class="copy-field__label">{{ label }}:</span>
  <span class="copy-field__value">
    {{ value }}
    <button
      type="button"
      class="copy-field__btn"
      :title="`Copy ${label}`"
      @click="handleCopy"
    >
      {{ copied ? 'Copied!' : '⧉' }}
    </button>
  </span>
</template>

<style scoped>
.copy-field__label {
  color: var(--mndw-text-subtle);
  font-weight: 600;
  white-space: nowrap;
}

.copy-field__value {
  color: var(--mndw-text);
  overflow-wrap: anywhere;
}

.copy-field__btn {
  margin-left: 4px;
  padding: 0;
  border: none;
  background: none;
  color: var(--mndw-accent);
  font: inherit;
  cursor: pointer;
  user-select: none;
}

.copy-field__btn:hover {
  text-decoration: underline;
}
</style>
