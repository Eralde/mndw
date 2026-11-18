<script lang="ts">
import type {PluginContext} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';

let {ctx}: {ctx: PluginContext} = $props();
const translator = $derived(createTranslator(ctx.i18n));
let backendMessage = $state<string | undefined>();
let backendError = $state(false);

const load = async (): Promise<void> => {
  if (ctx.backend === undefined) {
    backendError = true;

    return;
  }

  try {
    const response = await ctx.backend.call<{message: string}>('hello', {
      as: 'json',
    });
    backendMessage = response.message;
    backendError = false;
  } catch {
    backendMessage = undefined;
    backendError = true;
  }
};
</script>

<section
  class="__MNDW_NAME__"
  aria-labelledby={ctx.kind === 'page' ? 'plugin-title' : undefined}
>
  {#if ctx.kind === 'page'}
    <h2 id="plugin-title">{$translator.t('l10n.title')}</h2>
  {/if}
  <p class="device">Device: {ctx.device.info.deviceName}</p>
  <mndw-button
    variant="primary"
    type="button"
    onclick={() => void load()}
  >
    {$translator.t('l10n.button')}
  </mndw-button>
  <p
    class="result"
    role={backendError ? 'alert' : 'status'}
    aria-live="polite"
  >
    {#if backendError}
      {$translator.t('l10n.error')}
    {:else if backendMessage !== undefined}
      {$translator.t('l10n.result')}: {backendMessage}
    {:else}
      {$translator.t('l10n.result')}
    {/if}
  </p>
</section>

<style>
.__MNDW_NAME__ {
  padding: var(--mndw-space-4);
  font-family: var(--mndw-font-sans);
  color: var(--mndw-text);
  background: var(--mndw-surface);
}

.__MNDW_NAME__ .device {
  margin: 0 0 var(--mndw-space-3);
  color: var(--mndw-text-muted);
}

.__MNDW_NAME__ .result {
  margin-block: var(--mndw-space-3) 0;
}
</style>
