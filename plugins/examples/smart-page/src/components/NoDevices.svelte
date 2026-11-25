<script lang="ts">
import type {Translator} from '@mndw/sdk';
import {errorMessageKey, undetectedUsbDisks} from '../model/format';
import type {ActionResult, PageState} from '../services/page-controller';
import type {UsbInfoMap} from '../services/usb-info';
import {isTerminalBackend} from './backend';
import BackendStatus from './BackendStatus.svelte';

interface Props {
  state: PageState;
  i18n: Translator;
  usbInfo?: UsbInfoMap;
  onDiscover: (targetDeviceId: string | undefined) => Promise<ActionResult>;
}

let {state: pageState, i18n, usbInfo = new Map(), onDiscover}: Props = $props();

// Before the first snapshot there is nothing to explain: the block only waits, and says nothing about drives.
const empty = $derived.by(() => {
  if (pageState.snapshot === null) { return {kind: 'loading'} as const; }

  return pageState.emptyState ?? {kind: 'never-ran'} as const;
});
let heading: HTMLElement | null = $state(null);
const undetected = $derived.by(() => {
  return empty.kind === 'nothing-found'
    ? undetectedUsbDisks(usbInfo, pageState.snapshot?.devices ?? [])
    : [];
});
const canSearch = $derived.by((): boolean => {
  return empty.kind !== 'no-utility' && empty.kind !== 'loading';
});
const operationPending = $derived.by((): boolean => {
  return pageState.operation?.status === 'queued'
    || pageState.operation?.status === 'running';
});

function t(key: string, values?: Record<string, unknown>): string {
  return i18n.t(key, values);
}

/** Takes focus back when a search that started here ends here. */
export function focusHeading(): void {
  heading?.focus();
}
</script>

<section
  class="no-devices"
  aria-labelledby="devices-title"
  data-testid="no-devices"
  data-kind={empty.kind}
>
  <h2
    id="devices-title"
    tabindex="-1"
    bind:this={heading}
  >
    {t('devices.title')}
  </h2>
  <BackendStatus
    availability={pageState.backendAvailability}
    {i18n}
  />

  <div
    class="result"
    role="status"
    aria-live="polite"
  >
    {#if empty.kind === 'nothing-found'}
      <p class="message">{t('empty.nothing-found')}</p>
      {#each undetected as disk (disk.path)}
        <p
          class="hint"
          data-testid={`undetected-${disk.path}`}
        >
          {
            disk.port === null
            ? t('empty.usb-missed-no-port', {name: disk.title})
            : t('empty.usb-missed', {name: disk.title, port: disk.port})
          }
        </p>
      {/each}
    {:else if empty.kind === 'no-utility'}
      <p class="message">{t('empty.no-utility')}</p>
    {:else if empty.kind === 'failed'}
      <p class="message">{t('empty.failed')}</p>
      <p class="hint">{t(errorMessageKey(empty.code))}</p>
    {:else if empty.kind === 'never-ran'}
      <p class="message">{t('devices.empty')}</p>
    {/if}
  </div>

  {#if canSearch}
    <mndw-button
      variant="primary"
      data-testid="discover"
      disabled={isTerminalBackend(pageState.backendAvailability)
      || operationPending}
      onclick={() => void onDiscover(undefined)}
    >{
      empty.kind === 'nothing-found' || empty.kind === 'failed'
      ? t('action.search-again')
      : t('action.find-devices')
    }</mndw-button>
  {/if}
</section>

<style>
.no-devices {
  display: grid;
  gap: var(--mndw-space-3);
  justify-items: center;
  max-width: 32rem;
  margin: 0 auto;
  padding: var(--mndw-space-5) var(--mndw-space-4);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  text-align: center;
}

.result {
  display: grid;
  gap: var(--mndw-space-3);
  justify-items: center;
}

h2,
p {
  margin: 0;
}

h2:focus-visible {
  outline: var(--mndw-focus-w) solid var(--mndw-focus-ring);
  outline-offset: var(--mndw-space-1);
}

h2 {
  font-weight: var(--mndw-weight-semibold);
  font-size: var(--mndw-text-lg);
}

.message {
  color: var(--mndw-text);
}

.hint {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}
</style>
