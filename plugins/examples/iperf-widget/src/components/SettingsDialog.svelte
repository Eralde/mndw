<script lang="ts">
import type {Translator} from '@mndw/sdk';
import {
  CUSTOM_SERVER_ID,
  SERVERS,
  type Settings,
  validateSettings,
} from '../model/settings.js';

interface Props {
  initialSettings: Settings;
  translator: Translator;
  onSave: (settings: Settings) => Promise<void>;
  onCancel: () => void;
}

let {initialSettings, translator, onSave, onCancel}: Props = $props();
// svelte-ignore state_referenced_locally
let draft = $state<Settings>({...initialSettings});
let errors = $state<Record<string, string>>({});
let saving = $state(false);

function t(key: string): string {
  return translator.t(key);
}

function errorKey(key: string): string {
  return t(`settings.errors.${errors[key] ?? ''}`);
}

function updateServer(event: CustomEvent<{value: string}>): void {
  draft.serverId = event.detail.value;
}

function updateInput(event: CustomEvent<{value: string}>): void {
  const control = event.currentTarget;

  if (!(control instanceof HTMLElement)) {
    return;
  }

  switch (control.getAttribute('name')) {
    case 'customHost':
      draft.customHost = event.detail.value;
      return;
    case 'customPort':
      draft.customPort = Number(event.detail.value);
      return;
    case 'duration':
      draft.duration = Number(event.detail.value);
      return;
    case 'streams':
      draft.streams = Number(event.detail.value);
      return;
  }
}

async function save(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  errors = validateSettings(draft);
  if (Object.keys(errors).length > 0 || saving) {
    return;
  }

  saving = true;
  try {
    await onSave({...draft});
  } finally {
    saving = false;
  }
}
</script>

<form
  class="settings"
  onsubmit={save}
>
  <mndw-field label={t('settings.server')}>
    <mndw-select
      name="serverId"
      value={draft.serverId}
      onmndwchange={updateServer}
    >
      {#each SERVERS as server (server.id)}
        <mndw-option value={server.id}>{server.city}, {server.country} — {
            server.host
          }</mndw-option>
      {/each}
      <mndw-option value={CUSTOM_SERVER_ID}>{t('settings.custom')}</mndw-option>
    </mndw-select>
  </mndw-field>
  {#if draft.serverId === CUSTOM_SERVER_ID}
    <mndw-field
      label={t('settings.host')}
      error={errors.customHost ? errorKey('customHost') : ''}
    >
      <mndw-input
        name="customHost"
        autocomplete="url"
        value={draft.customHost}
        onmndwinput={updateInput}
      ></mndw-input>
    </mndw-field>
    <mndw-field
      label={t('settings.port')}
      error={errors.customPort ? errorKey('customPort') : ''}
    >
      <mndw-input
        name="customPort"
        type="number"
        min="1"
        max="65535"
        step="1"
        value={String(draft.customPort)}
        onmndwinput={updateInput}
      ></mndw-input>
    </mndw-field>
  {/if}
  <mndw-field
    label={t('settings.duration')}
    error={errors.duration ? errorKey('duration') : ''}
  >
    <mndw-input
      name="duration"
      type="number"
      min="5"
      max="30"
      step="1"
      value={String(draft.duration)}
      onmndwinput={updateInput}
    ></mndw-input>
  </mndw-field>
  <mndw-field
    label={t('settings.streams')}
    error={errors.streams ? errorKey('streams') : ''}
  >
    <mndw-input
      name="streams"
      type="number"
      min="1"
      max="8"
      step="1"
      value={String(draft.streams)}
      onmndwinput={updateInput}
    ></mndw-input>
  </mndw-field>
  <div class="actions">
    <mndw-button
      type="button"
      size="sm"
      data-testid="cancel-settings"
      onclick={onCancel}
    >{t('action.cancel')}</mndw-button>
    <mndw-button
      type="submit"
      size="sm"
      variant="primary"
      data-testid="save-settings"
      disabled={saving}
    >
      {t('action.save')}
    </mndw-button>
  </div>
</form>

<style>
.settings {
  display: grid;
  gap: 1rem;
  color: var(--mndw-text);
}

.actions {
  display: flex;
  justify-content: end;
  gap: 0.5rem;
}
</style>
