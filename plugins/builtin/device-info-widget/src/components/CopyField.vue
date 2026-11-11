<script setup lang="ts">
import {computed, onBeforeUnmount, ref} from 'vue';
import type {Translator} from '@mndw/sdk';
import {copyText} from '../services/clipboard';

const props = withDefaults(defineProps<{
  label: string;
  value: string;
  translator: Translator;
}>(), {
});

type CopyState = 'idle' | 'copied' | 'failed';

const copyState = ref<CopyState>('idle');
const valueElement = ref<HTMLElement | null>(null);
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

const copied = computed(() => copyState.value === 'copied');

const statusMessage = computed(() => {
  if (copyState.value === 'copied') {
    return props.translator.t('copied');
  }

  if (copyState.value === 'failed') {
    return props.translator.t('copy-failed');
  }

  return '';
});

const clearFeedbackTimer = (): void => {
  if (feedbackTimer !== undefined) {
    clearTimeout(feedbackTimer);
    feedbackTimer = undefined;
  }
};

const showCopied = (): void => {
  clearFeedbackTimer();
  copyState.value = 'copied';
  feedbackTimer = setTimeout(() => {
    copyState.value = 'idle';
    feedbackTimer = undefined;
  }, 1500);
};

const selectValueText = (): void => {
  const element = valueElement.value;

  if (element === null) {
    return;
  }

  const selection = window.getSelection();

  if (selection === null) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
};

const handleCopy = async (): Promise<void> => {
  let copiedSuccessfully = false;

  try {
    copiedSuccessfully = await copyText(props.value);
  } catch (ex) {
    console.error('[device-info-widget] copy failed', ex);
  }

  if (copiedSuccessfully) {
    showCopied();
    return;
  }

  clearFeedbackTimer();
  copyState.value = 'failed';

  try {
    selectValueText();
  } catch (ex) {
    console.error('[device-info-widget] selecting value after failed copy failed', ex);
  }
};

onBeforeUnmount(clearFeedbackTimer);
</script>

<template>
  <span class="copy-field__label">{{ label }}:</span>
  <span class="copy-field__value">
    <span ref="valueElement" class="copy-field__text">{{ value }}</span>
    <mndw-button
      variant="ghost"
      class="copy-field__btn"
      :aria-label="`${props.translator.t('copy')} ${label}`"
      :title="`${props.translator.t('copy')} ${label}`"
      @click="handleCopy"
    >
      {{ copied ? props.translator.t('copied') : '⧉' }}
    </mndw-button>
    <span
      class="copy-field__status"
      :class="{'copy-field__status--sr-only': copyState !== 'failed'}"
      role="status"
      aria-live="polite"
    >{{ statusMessage }}</span>
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
  display: inline-block;
  margin-left: 0.25rem;
  user-select: none;
}

.copy-field__btn::part(button) {
  min-height: auto;
  padding: 0;
  color: var(--mndw-accent);
  font: inherit;
}

.copy-field__status {
  display: block;
  margin-top: 0.25rem;
  color: var(--mndw-text-subtle);
  font-size: 0.75rem;
}

.copy-field__status--sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
