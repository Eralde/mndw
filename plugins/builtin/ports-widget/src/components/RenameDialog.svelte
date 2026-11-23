<script lang="ts">
import type {Translator} from '@mndw/sdk/svelte';
import {validatePortDescription} from '../rci/port-description.js';

let {
  description,
  translator,
  onsave,
  onclose,
}: {
  description: string | null;
  translator: Translator;
  onsave: (value: string | null) => Promise<string | null>;
  onclose: () => void;
} = $props();

// svelte-ignore state_referenced_locally
let nameValue = $state(description ?? '');
let clearRequested = $state(false);
let saving = $state(false);
let saveError = $state<string | null>(null);

function changeName(event: CustomEvent<{value: string}>): void {
  nameValue = event.detail.value;
  clearRequested = false;
  saveError = null;
}

function clearName(): void {
  nameValue = '';
  clearRequested = true;
  saveError = null;
}

async function save(): Promise<void> {
  if (saving) {
    return;
  }

  const validation = clearRequested ? null : validatePortDescription(nameValue);

  if (validation?.kind === 'invalid') {
    saveError = translator.t(
      validation.reason === 'empty'
        ? 'details.nameEmpty'
        : 'details.nameTooLong',
    );

    return;
  }

  saving = true;

  try {
    const error = await onsave(
      validation?.kind === 'valid' ? validation.value : null,
    );

    if (error !== null) {
      saveError = error;

      return;
    }

    onclose();
  } finally {
    saving = false;
  }
}

function submit(event: Event): void {
  event.preventDefault();
  void save();
}
</script>

<form
  class="rename"
  onsubmit={submit}
>
  <mndw-field
    label={translator.t('details.name')}
    error={saveError ?? ''}
  >
    <mndw-input
      type="text"
      value={nameValue}
      maxlength="64"
      autocomplete="off"
      onmndwinput={changeName}
    ></mndw-input>
  </mndw-field>
  <div class="actions">
    <mndw-button
      class="save"
      type="submit"
      size="sm"
      variant="primary"
      disabled={saving}
      onclick={submit}
    >{translator.t('details.save')}</mndw-button>
    <mndw-button
      class="clear"
      type="button"
      size="sm"
      disabled={saving}
      onclick={clearName}
    >{translator.t('details.clear')}</mndw-button>
    <mndw-button
      class="cancel"
      type="button"
      size="sm"
      disabled={saving}
      onclick={onclose}
    >{translator.t('details.cancel')}</mndw-button>
  </div>
</form>

<style>
.rename {
  display: flex;
  flex-direction: column;
  gap: var(--mndw-space-3);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
}

mndw-input {
  width: 100%;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-1);
  justify-content: flex-end;
}
</style>
