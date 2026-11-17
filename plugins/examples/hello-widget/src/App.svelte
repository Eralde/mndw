<script lang="ts">
import {type BackendClient, BackendError, type PluginI18n} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';

interface Props {
  backend: BackendClient | undefined;
  i18n: PluginI18n;
  signal: AbortSignal;
}

type ViewState = 'idle' | 'loading' | 'success' | 'error';

let {backend, i18n, signal}: Props = $props();
const translator = $derived(createTranslator(i18n));
let state = $state<ViewState>('idle');
let message = $state('');

async function loadGreeting(): Promise<void> {
  if (state === 'loading') { return; }
  if (!backend) {
    state = 'error';
    message = $translator.t('error.backend-missing');
    return;
  }
  state = 'loading';
  message = '';
  try {
    const payload = await backend.call<{message?: unknown}>('hello', {
      as: 'json',
      signal,
    });
    if (signal.aborted) { return; }
    const greeting = typeof payload.message === 'string'
      ? payload.message.trim()
      : '';
    if (greeting === '') {
      throw new Error('Hello backend returned an invalid greeting');
    }
    state = 'success';
    message = greeting;
  } catch (error) {
    if (signal.aborted) { return; }
    const code = error instanceof BackendError ? error.code : undefined;
    state = 'error';
    message = code === 'NOT_APPROVED'
      ? $translator.t('error.backend-not-approved')
      : code === 'DISABLED'
      ? $translator.t('error.backend-disabled')
      : code === 'BACKEND_STARTING' || code === 'BACKEND_UNAVAILABLE'
          || code === 'BACKEND_MAINTENANCE'
      ? $translator.t('error.backend-unavailable')
      : $translator.t('error.greeting-failed');
  }
}
</script>

<section class="hello-widget">
  <mndw-button
    variant="primary"
    type="button"
    data-testid="greet"
    disabled={state === 'loading'}
    onclick={() => void loadGreeting()}
  >
    {
      state === 'loading'
      ? $translator.t('action.loading')
      : $translator.t('action.greet')
    }
  </mndw-button>
  <p
    class:error={state === 'error'}
    role={state === 'error' ? 'alert' : 'status'}
    aria-live="polite"
  >
    {
      state === 'success' || state === 'error'
      ? message
      : state === 'loading'
      ? $translator.t('status.loading')
      : $translator.t('status.idle')
    }
  </p>
</section>

<style>
.hello-widget {
  display: grid;
  gap: var(--mndw-space-3);
  padding: var(--mndw-space-4);
  color: var(--mndw-text);
  background: var(--mndw-surface);
  font-family: var(--mndw-font-sans);
}

p {
  margin: 0;
}

mndw-button {
  justify-self: start;
}

.error {
  color: var(--mndw-danger);
}
</style>
