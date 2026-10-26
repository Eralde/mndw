<script lang="ts">
import {onDestroy, onMount} from 'svelte';
import {
  EMPTY,
  Subject,
  Subscription,
  catchError,
  defer,
  exhaustMap,
  filter,
  finalize,
  map,
  switchMap,
  tap,
} from 'rxjs';
import type {RciManager} from '@rci-tools/core';
import type {PluginI18n} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';
import {
  type DescriptionValidation,
  DeviceRciStatusError,
  createDeviceDescriptionApi,
  validateDescription,
} from './device-description.js';

interface Props {
  rci: RciManager;
  i18n: PluginI18n;
}

let {rci, i18n}: Props = $props();
const translator = $derived(createTranslator(i18n));
// svelte-ignore state_referenced_locally
const api = createDeviceDescriptionApi(rci);

let description = $state('');
let confirmedDescription = $state('');
let originalDescription = $state<string | undefined>(undefined);
let hasLoaded = $state(false);
let isLoading = $state(true);
let isSaving = $state(false);
let loadError = $state('');
let saveError = $state('');
let validationMessage = $state('');
let saveSucceeded = $state(false);

const loadIntents = new Subject<void>();
const saveIntents = new Subject<string>();
const subscriptions = new Subscription();

let canSave = $derived.by(() => {
  const validation = validateDescription(description);

  return hasLoaded && !isLoading && !isSaving && validation.kind === 'valid'
    && validation.value !== confirmedDescription;
});

let canRestore = $derived.by(() => {
  return hasLoaded && !isLoading && !isSaving
    && originalDescription !== undefined
    && originalDescription !== ''
    && originalDescription !== confirmedDescription;
});

function translate(key: string): string {
  return $translator.t(key);
}

function handleInput(): void {
  const validation = validateDescription(description);

  validationMessage = validation.kind === 'invalid'
    ? translate(validation.message)
    : '';
  saveError = '';
  saveSucceeded = false;
}

function getSaveError(error: unknown): string {
  return error instanceof DeviceRciStatusError
    ? error.message
    : translate('error.save');
}

function submitSave(): void {
  saveIntents.next(description);
}

function restoreOriginal(): void {
  if (originalDescription !== undefined) {
    saveIntents.next(originalDescription);
  }
}

subscriptions.add(
  loadIntents.pipe(
    exhaustMap(() =>
      defer(() => {
        isLoading = true;
        loadError = '';

        return api.read().pipe(
          tap((deviceDescription) => {
            if (!hasLoaded) {
              originalDescription = deviceDescription;
            }

            confirmedDescription = deviceDescription;
            description = deviceDescription;
            hasLoaded = true;
            saveError = '';
            saveSucceeded = false;
            validationMessage = '';
          }),
          catchError(() => {
            loadError = translate('error.load');

            return EMPTY;
          }),
          finalize(() => {
            isLoading = false;
          }),
        );
      })
    ),
  ).subscribe(),
);

subscriptions.add(
  saveIntents.pipe(
    map((value) => validateDescription(value)),
    tap((validation) => {
      validationMessage = validation.kind === 'invalid'
        ? translate(validation.message)
        : '';
    }),
    filter((
      validation,
    ): validation is Extract<DescriptionValidation, {kind: 'valid'}> =>
      validation.kind === 'valid'
    ),
    exhaustMap(({value}) =>
      defer(() => {
        isSaving = true;
        saveError = '';
        validationMessage = '';
        saveSucceeded = false;

        return api.write(value).pipe(
          switchMap(() => api.read()),
          tap((deviceDescription) => {
            confirmedDescription = deviceDescription;
            description = deviceDescription;
            saveSucceeded = true;
          }),
          catchError((error: unknown) => {
            saveError = getSaveError(error);

            return EMPTY;
          }),
          finalize(() => {
            isSaving = false;
          }),
        );
      })
    ),
  ).subscribe(),
);

onMount(() => {
  loadIntents.next();
});

onDestroy(() => {
  loadIntents.complete();
  saveIntents.complete();
  subscriptions.unsubscribe();
});
</script>

<section
  class="device-description"
  aria-labelledby="device-description-title"
>
  <h2 id="device-description-title">{$translator.t('title')}</h2>

  <label for="device-description-input">{$translator.t('field.label')}</label>
  <input
    id="device-description-input"
    data-testid="description"
    type="text"
    placeholder={$translator.t('field.placeholder')}
    disabled={!hasLoaded || isLoading || isSaving}
    bind:value={description}
    oninput={handleInput}
  />

  <div class="actions">
    <button
      type="button"
      data-testid="save"
      disabled={!canSave}
      onclick={submitSave}
    >
      {$translator.t('action.save')}
    </button>
    <button
      type="button"
      data-testid="restore"
      disabled={!canRestore}
      onclick={restoreOriginal}
    >
      {$translator.t('action.restore')}
    </button>
    {#if loadError}
      <button
        type="button"
        data-testid="retry"
        disabled={isLoading}
        onclick={() => loadIntents.next()}
      >
        {$translator.t('action.retry')}
      </button>
    {/if}
  </div>

  {#if hasLoaded && originalDescription === ''}
    <p
      class="hint"
      data-testid="restore-empty"
    >
      {$translator.t('error.restore-empty')}
    </p>
  {/if}

  {#if isLoading}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.loading')}
    </p>
  {:else if loadError}
    <p
      class="error"
      role="alert"
      aria-live="polite"
    >
      {loadError}
    </p>
  {:else if isSaving}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.saving')}
    </p>
  {:else if saveError}
    <p
      class="error"
      role="alert"
      aria-live="polite"
    >
      {saveError}
    </p>
  {:else if validationMessage}
    <p
      class="error"
      role="alert"
      aria-live="polite"
    >
      {validationMessage}
    </p>
  {:else if saveSucceeded}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.saved')}
    </p>
  {:else if hasLoaded}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.loaded')}
    </p>
  {/if}
</section>

<style>
.device-description {
  display: grid;
  gap: var(--mndw-space-3);
  padding: var(--mndw-space-4);
  color: var(--mndw-text);
  background: var(--mndw-surface);
  font-family: var(--mndw-font-sans);
}

h2,
p {
  margin: 0;
}

h2 {
  font-size: var(--mndw-text-lg);
  font-weight: var(--mndw-weight-semibold);
}

label {
  font-size: var(--mndw-text-sm);
  font-weight: var(--mndw-weight-medium);
}

input {
  min-width: 0;
  padding: var(--mndw-space-2) var(--mndw-space-3);
  color: var(--mndw-text);
  background: var(--mndw-surface-raised);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  font: inherit;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
}

button {
  padding: var(--mndw-space-2) var(--mndw-space-3);
  color: var(--mndw-accent-contrast);
  background: var(--mndw-accent);
  border: 0;
  border-radius: var(--mndw-radius-md);
  cursor: pointer;
  font: inherit;
}

button:disabled,
input:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.hint {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.error {
  color: var(--mndw-danger);
}
</style>
