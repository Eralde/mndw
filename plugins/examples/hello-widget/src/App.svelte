<script lang="ts">
import {onDestroy} from 'svelte';
import {
  type BackendClient,
  BackendDisabled,
  BackendNotApproved,
  BackendUnavailable,
  type PluginI18n,
} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';

interface Props {
  backend: BackendClient | undefined;
  i18n: PluginI18n;
}

type ViewState = 'idle' | 'loading' | 'success' | 'error';

let {backend, i18n}: Props = $props();
const translator = $derived(createTranslator(i18n));
let state = $state<ViewState>('idle');
let message = $state('');
let disposed = false;
let requestGeneration = 0;

function getErrorMessage(error: unknown): string {
  if (error instanceof BackendNotApproved) {
    return $translator.t('error.backend-not-approved');
  }

  if (error instanceof BackendDisabled) {
    return $translator.t('error.backend-disabled');
  }

  if (error instanceof BackendUnavailable) {
    return $translator.t('error.backend-unavailable');
  }

  return $translator.t('error.greeting-failed');
}

function readGreeting(payload: unknown): string | undefined {
  if (
    payload === null || typeof payload !== 'object' || Array.isArray(payload)
  ) {
    return undefined;
  }

  const candidate = (payload as Record<string, unknown>).message;

  return typeof candidate === 'string' && candidate.trim() !== ''
    ? candidate.trim()
    : undefined;
}

async function loadGreeting(): Promise<void> {
  if (state === 'loading') {
    return;
  }

  if (!backend) {
    state = 'error';
    message = $translator.t('error.backend-missing');

    return;
  }

  const generation = ++requestGeneration;

  state = 'loading';
  message = '';

  try {
    const response = await backend.fetch('hello');

    if (!response.ok) {
      throw new Error('Hello backend returned a non-OK response');
    }

    const payload: unknown = await response.json();
    const greeting = readGreeting(payload);

    if (greeting === undefined) {
      throw new Error('Hello backend returned an invalid greeting');
    }

    if (!disposed && generation === requestGeneration) {
      state = 'success';
      message = greeting;
    }
  } catch (error) {
    if (!disposed && generation === requestGeneration) {
      state = 'error';
      message = getErrorMessage(error);
    }
  }
}

onDestroy(() => {
  disposed = true;
  requestGeneration++;
});
</script>

<section
  class="hello-widget"
  aria-labelledby="hello-title"
>
  <h2 id="hello-title">{$translator.t('title')}</h2>
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

h2,
p {
  margin: 0;
}

h2 {
  font-size: var(--mndw-text-lg);
  font-weight: var(--mndw-weight-semibold);
}

mndw-button {
  justify-self: start;
}

.error {
  color: var(--mndw-danger);
}
</style>
