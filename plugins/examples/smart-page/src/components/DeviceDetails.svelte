<script lang="ts">
import type {Translator} from '@mndw/sdk';
import {untrack} from 'svelte';
import type {Device, DeviceTypeOverride} from '../model/api';
import {
  type CollectionResultText,
  assessmentSummary,
  deviceTitle,
  formatCapacity,
  formatDateTime,
  formatDecimal,
  formatNullable,
  readSummary,
  usbTitle,
} from '../model/format';
import type {WakeDecision} from '../services/confirm-wake';
import type {ActionResult, PageState} from '../services/page-controller';
import type {UsbInfoMap} from '../services/usb-info';
import {wakeConsentKey} from '../services/wake-consent';
import {isTerminalBackend} from './backend';
import DefinitionList, {type Row} from './DefinitionList.svelte';
import DeviceTypeEditor from './DeviceTypeEditor.svelte';
import SampleReadings from './SampleReadings.svelte';

interface Props {
  state: PageState;
  i18n: Translator;
  locale?: string;
  usbInfo?: UsbInfoMap;
  onDiscover: (targetDeviceId: string | undefined) => Promise<ActionResult>;
  onRefresh: (
    targetDeviceId: string | undefined,
    rememberConsent?: boolean,
  ) => Promise<ActionResult>;
  onSetDeviceType: (
    deviceId: string,
    deviceType: DeviceTypeOverride | null,
  ) => Promise<ActionResult>;
  /** Asks whether a read may wake the drive; resolves with the answer once the dialog is closed. */
  confirmWake: (
    canRemember: boolean,
    signal: AbortSignal,
  ) => Promise<WakeDecision>;
  /** Called when a closed dialog left focus on the page body and these details are hidden, so the page can place it. */
  onFocusLost?: () => void;
}

let {state: pageState, i18n, locale, usbInfo = new Map(), onDiscover, onRefresh,
  onSetDeviceType, confirmWake, onFocusLost}: Props = $props();

const displayLocale = $derived.by((): string => {
  return locale ?? i18n.locale;
});

const device = $derived.by((): Device | null => {
  if (
    pageState.snapshot === null || pageState.selectedDeviceId === null
  ) { return null; }

  return pageState.snapshot.devices.find((item) =>
    item.deviceId === pageState.selectedDeviceId
  ) ?? null;
});
const disconnected = $derived.by((): boolean => {
  return device?.binding === 'disconnected'
    || device?.collection.status === 'disconnected';
});
const terminalBackend = $derived.by((): boolean => {
  return isTerminalBackend(pageState.backendAvailability);
});
// A disconnected drive starts discovery from here, and the list that shows it may be hidden. Only a read is
// announced here: the list column already announces discovery.
const shownOperation = $derived.by(() => {
  const operation = pageState.operation;

  return operation?.kind === 'refresh'
      || (disconnected && operation?.kind === 'discover')
    ? operation
    : null;
});
let heading: HTMLElement | null = $state(null);
const operationPending = $derived.by((): boolean => {
  return pageState.operation?.status === 'queued'
    || pageState.operation?.status === 'running';
});
const selectedWakeConsentKey = $derived.by((): string | null => {
  return wakeConsentKey(device?.sample ?? null);
});
const skipsWakeConfirmation = $derived.by((): boolean => {
  return !pageState.wakeConfirmationRequired;
});
let waking = false;
let wakeAbort: AbortController | null = null;
const wakeBlocked = $derived.by((): boolean => {
  return disconnected || terminalBackend || operationPending;
});
const assessment = $derived.by(() => {
  return assessmentSummary(device?.sample ?? null);
});
const read = $derived.by(() => {
  return device === null
    ? null
    : readSummary(device.collection, device.freshness);
});
const identityRows = $derived.by((): Row[] => {
  if (device === null) { return []; }

  const sample = device.sample;
  const usb = usbInfo.get(device.path);
  const pairs = [
    {key: 'field.model', value: formatNullable(sample?.identity.model ?? null)},
    {key: 'field.serial',
      value: formatNullable(sample?.identity.serial ?? null)},
    {key: 'field.capacity', value: formatCapacity(
      sample?.identity.capacityBytes ?? usb?.sizeBytes ?? null,
      displayLocale,
      t,
    )},
    {key: 'field.path', value: device.path},
    {key: 'field.protocol',
      value: t(`protocol.${sample?.protocol ?? 'unknown'}`)},
  ];

  if (sample !== null) {
    pairs.push({
      key: 'field.temperature',
      value: sample.temperatureC === null
        ? formatNullable(null)
        : `${sample.temperatureC} ${t('unit.celsius')}`,
    });
  }

  pairs.push({key: 'field.power-on-hours',
    value: formatDecimal(sample?.powerOnHours ?? '—')});

  const usbDevice = usbTitle(usb);

  if (usbDevice !== null) {
    pairs.push({key: 'field.usb-device', value: usbDevice});
  }
  if (usb?.port !== null && usb?.port !== undefined) {
    pairs.push({key: 'field.usb-port', value: usb.port});
  }
  if (usb?.usbVersion !== null && usb?.usbVersion !== undefined) {
    pairs.push({key: 'field.usb-version', value: usb.usbVersion});
  }

  return pairs.map((pair) => ({key: pair.key, label: t(pair.key),
    value: pair.value})
  );
});

function t(key: string, values?: Record<string, unknown>): string {
  return i18n.t(key, values);
}

/** Moves focus to the drive name when the narrow layout opens this view. */
export function focusHeading(): void {
  heading?.focus();
}

function resultLabel(result: CollectionResultText): string {
  if (result.kind === 'plain') { return t(result.key); }

  if (result.kind === 'with-code') {
    return t(result.key, {
      code: result.code,
    });
  }

  const status = t(result.statusKey);

  return result.code === null
    ? status
    : `${status} (${t('collection.exit-code')}: ${result.code})`;
}

// Every poll publishes a new state object, so the effect must depend on values that are compared, not on the prop:
// a derived only notifies when its own value changes.
const selectedId = $derived(pageState.selectedDeviceId);

// The page keeps polling behind the modal, so everything that disables the read button can change while the dialog
// is open. A dialog whose question no longer applies is closed instead of left to be answered.
$effect(() => {
  void wakeBlocked;
  void selectedId;
  untrack(() => wakeAbort?.abort());
});

async function refresh(targetDeviceId: string): Promise<void> {
  if (waking || !isTargetCurrent(targetDeviceId)) { return; }

  if (skipsWakeConfirmation) {
    void onRefresh(targetDeviceId);

    return;
  }

  const abort = new AbortController();
  const hadFocus = document.activeElement !== null
    && document.activeElement !== document.body;

  waking = true;
  wakeAbort = abort;

  try {
    const decision = await confirmWake(
      selectedWakeConsentKey !== null,
      abort.signal,
    );

    if (
      decision.confirmed && !abort.signal.aborted
      && isTargetCurrent(targetDeviceId) && !wakeBlocked
    ) {
      void onRefresh(targetDeviceId, decision.remember);
    }
  } finally {
    wakeAbort = null;
    waking = false;
  }

  // The host returns focus to the button that opened the dialog; when a swap removed it, focus would be lost.
  if (
    hadFocus
    && (document.activeElement === null
      || document.activeElement === document.body)
  ) {
    // In the narrow layout these details can be hidden by now (the drive left the snapshot): focus belongs to the list.
    if (heading?.checkVisibility() ?? false) {
      heading?.focus();
    } else {
      onFocusLost?.();
    }
  }
}

function isTargetCurrent(targetDeviceId: string | undefined): boolean {
  return targetDeviceId !== undefined
    && pageState.selectedDeviceId === targetDeviceId;
}
</script>

<section
  class="device-details"
  aria-labelledby="details-title"
>
  <div class="header">
    <h2
      id="details-title"
      tabindex="-1"
      bind:this={heading}
    >
      {
        device === null
        ? t('details.title')
        : deviceTitle(device, usbInfo)
      }
    </h2>
    {#if device !== null}
      {#key device.deviceId}
        <div class="actions">
          {#if disconnected}
            <mndw-button
              variant="primary"
              data-testid="find-devices"
              disabled={terminalBackend || operationPending}
              onclick={() => {
                if (isTargetCurrent(device.deviceId)) {
                  void onDiscover(
                    device.deviceId,
                  );
                }
              }}
            >{t('action.find-devices')}</mndw-button>
          {:else}
            <mndw-button
              variant="primary"
              data-testid="refresh"
              disabled={terminalBackend || operationPending}
              onclick={() => void refresh(device.deviceId)}
            >{t('action.manual-refresh')}</mndw-button>
          {/if}
        </div>
      {/key}
    {/if}
  </div>
  {#if shownOperation !== null}
    <p
      class="operation-status"
      role={shownOperation.kind === 'refresh' ? 'status' : undefined}
    >
      {t(`operation.${shownOperation.kind}`)}: {
        t(`operation.${shownOperation.status}`)
      }
    </p>
  {/if}

  {#if device === null}
    <p class="empty-state">
      {
        pageState.emptyState === null
        ? t('details.no-selection')
        : t('details.placeholder')
      }
    </p>
  {:else}
    {#key device.deviceId}
      <section
        class="summary"
        aria-labelledby="summary-title"
      >
        <h3 id="summary-title">{t('details.assessment')}</h3>
        <p class="health-line">
          <strong>{t(assessment.healthKey)}</strong>
          {#if assessment.levelKey !== null}
            <span aria-hidden="true">·</span>
            <span>{t(assessment.levelKey)}</span>
          {/if}
          {#if assessment.reasonKeys.length === 1}
            <span aria-hidden="true">·</span>
            <span class="muted">{t(assessment.reasonKeys[0] ?? '')}</span>
          {/if}
        </p>
        {#if assessment.reasonKeys.length > 1}
          <ul class="reasons">
            {#each assessment.reasonKeys as reasonKey (reasonKey)}
              <li>{t(reasonKey)}</li>
            {/each}
          </ul>
        {/if}
        {#if read?.kind === 'never-read'}
          <p class="collection-line">{t('collection.never-read')}</p>
        {:else if read?.kind === 'result-only'}
          <p class="collection-line">{resultLabel(read.result)}</p>
        {:else if read?.kind === 'succeeded'}
          <p class="collection-line">
            {resultLabel(read.result)}: {@render readTime(read.at)}
            {#if read.stale}{@render staleNote()}{/if}
          </p>
        {:else if read?.kind === 'attempted'}
          <p class="collection-line">
            {t('collection.label')}: {resultLabel(read.result)}
          </p>
          <p class="freshness-line">
            {#if read.successAt === null}
              {t('freshness.no-successful-read-yet')}
            {:else}
              {t('freshness.last-success')}: {@render readTime(read.successAt)}
              {#if read.stale}{@render staleNote()}{/if}
            {/if}
          </p>
        {/if}
      </section>

      <section
        class="card identity"
        aria-labelledby="identity-title"
      >
        <h3 id="identity-title">{t('details.drive')}</h3>
        <DefinitionList rows={identityRows} />
      </section>
      {#if device.sample !== null}
        <SampleReadings
          sample={device.sample}
          {i18n}
          locale={displayLocale}
        />
      {/if}

      <DeviceTypeEditor
        {device}
        {i18n}
        disabled={terminalBackend || operationPending}
        isTargetCurrent={(targetDeviceId) => pageState.selectedDeviceId === targetDeviceId}
        onSetDeviceType={(targetDeviceId, deviceType) =>
        onSetDeviceType(targetDeviceId, deviceType)}
      />
    {/key}
  {/if}
</section>

{#snippet readTime(value: string)}
  <time
    datetime={value}
    title={value}
  >{formatDateTime(value, displayLocale)}</time>
{/snippet}

{#snippet staleNote()}
  <span class="muted"><span aria-hidden="true">·</span> {
      t('freshness.older-than-60-minutes')
    }</span>
{/snippet}

<style>
.device-details {
  display: grid;
  gap: var(--mndw-space-4);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

h2,
h3,
p {
  margin: 0;
}

h2 {
  min-width: 0;
  font-weight: var(--mndw-weight-semibold);
  font-size: var(--mndw-text-lg);
  overflow-wrap: anywhere;
}

h3 {
  margin-bottom: var(--mndw-space-2);
  font-weight: var(--mndw-weight-semibold);
  font-size: var(--mndw-text-md);
}

.summary,
.card {
  display: grid;
  gap: var(--mndw-space-2);
  padding: var(--mndw-space-3);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  background: var(--mndw-surface-raised);
}

/* The title takes the row's spare width, so the actions sit at its end beside it and at the start once they wrap
   under it. */
.header {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-3);
  justify-content: flex-start;
  align-items: center;
  min-height: var(--smart-header-min-h);
}

.header h2 {
  flex: 1 1 12rem;
}

h2:focus-visible {
  outline: var(--mndw-focus-w) solid var(--mndw-focus-ring);
  outline-offset: var(--mndw-space-1);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
  max-width: 100%;
}

.operation-status {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

/* A card follows its own width, not the viewport: the page sits beside the host sidebar. */
.card {
  container-type: inline-size;
}

.muted {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.reasons {
  display: grid;
  gap: var(--mndw-space-1);
  margin: 0;
  padding-left: var(--mndw-space-4);
}

.empty-state {
  color: var(--mndw-text-muted);
}
</style>
