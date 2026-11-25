<script lang="ts">
import type {Translator} from '@mndw/sdk';
import type {Device} from '../model/api';
import {
  assessmentSummary,
  deviceTitle,
  formatBytes,
  formatDateTime,
} from '../model/format';
import type {ActionResult, PageState} from '../services/page-controller';
import type {UsbInfoMap} from '../services/usb-info';
import {isTerminalBackend} from './backend';
import BackendStatus from './BackendStatus.svelte';

interface Props {
  state: PageState;
  i18n: Translator;
  locale?: string;
  usbInfo?: UsbInfoMap;
  onDiscover: (targetDeviceId: string | undefined) => Promise<ActionResult>;
  onSelect: (deviceId: string) => void;
}

let {state: pageState, i18n, locale, usbInfo = new Map(), onDiscover, onSelect}:
  Props = $props();

const displayLocale = $derived.by((): string => {
  return locale ?? i18n.locale;
});
const searching = $derived.by((): boolean => {
  return pageState.emptyState?.kind === 'searching';
});
const discoverDisabled = $derived.by((): boolean => {
  return searching || isTerminalBackend(pageState.backendAvailability)
    || pageState.operation?.status === 'queued'
    || pageState.operation?.status === 'running';
});
const discovery = $derived.by(() => {
  const operation = pageState.operation;

  return operation?.kind === 'discover' ? operation : null;
});

type DiscoveryStatus =
  | {kind: 'unknown'}
  | {kind: 'none'}
  | {kind: 'running'}
  | {kind: 'succeeded' | 'failed'; completedAt: string | null};

// One status for the panel. A scan the page did not start (the automatic one, a followed busy scan) has no operation,
// so the list's own search state counts as running too.
const discoveryStatus = $derived.by((): DiscoveryStatus => {
  if (
    searching || discovery?.status === 'queued'
    || discovery?.status === 'running'
  ) {
    return {kind: 'running'};
  }

  if (
    discovery?.status === 'failed' || pageState.emptyState?.kind === 'failed'
  ) {
    return {kind: 'failed', completedAt: discovery?.completedAt ?? null};
  }

  if (discovery?.status === 'succeeded') {
    return {kind: 'succeeded', completedAt: discovery.completedAt};
  }

  // No operation of ours: the page was reloaded, or opened in a second tab, or the scan was canceled. The snapshot
  // still tells whether the backend ever ran one, though not when.
  const snapshot = pageState.snapshot;

  if (snapshot === null) { return {kind: 'unknown'}; }

  return snapshot.diagnostics.reasons.includes('discovery-not-run')
    ? {kind: 'none'}
    : {kind: 'succeeded', completedAt: null};
});

let host: HTMLElement | null = $state(null);
let heading: HTMLElement | null = $state(null);

function t(key: string): string {
  return i18n.t(key);
}

/** Takes focus when the list replaces the block that held it, or when the opened drive is gone. */
export function focusHeading(): void {
  heading?.focus();
}

/** Moves focus back to a card, for the narrow layout's return from the details view. */
export function focusDevice(deviceId: string): void {
  const cards = host?.querySelectorAll<HTMLElement>('[data-device-id]') ?? [];

  [...cards].find((card) => card.dataset.deviceId === deviceId)?.focus();
}

// The same rule as the details: an unknown level only repeats an unknown health, so the chip leaves it out.
function chipLabel(sample: NonNullable<Device['sample']>): string {
  const {healthKey, levelKey} = assessmentSummary(sample);

  return levelKey === null ? t(healthKey) : `${t(healthKey)} · ${t(levelKey)}`;
}

function deviceMetadata(device: Device): string {
  const usb = usbInfo.get(device.path);
  const parts = [device.path];
  const capacity = formatBytes(
    usb?.sizeBytes ?? device.sample?.identity.capacityBytes ?? null,
    displayLocale,
    t,
  );

  if (usb?.port !== null && usb?.port !== undefined) {
    parts.push(`${t('field.usb-port')} ${usb.port}`);
  }
  if (capacity !== null) { parts.push(capacity); }

  return parts.join(' · ');
}
</script>

<section
  class="device-list"
  aria-labelledby="devices-title"
  bind:this={host}
>
  <div class="heading">
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
  </div>

  <div
    class="discovery-panel"
    data-testid="discovery-panel"
  >
    <mndw-button
      variant="primary"
      data-testid="discover"
      disabled={discoverDisabled}
      onclick={() => void onDiscover(undefined)}
    >{t('action.find-devices')}</mndw-button>
    <!-- Always mounted, so a screen reader announces each change instead of a fresh node. -->
    <div
      class="discovery-status"
      role="status"
      data-testid="discovery-status"
      data-state={discoveryStatus.kind}
    >
      {#if discoveryStatus.kind === 'running'}
        <div
          class="status-running"
          data-testid="searching"
        >
          <span
            class="status-progress"
            aria-hidden="true"
          ><mndw-progress></mndw-progress></span>
          <span>{t('discovery.searching')}</span>
        </div>
      {:else if discoveryStatus.kind === 'failed'}
        <p class="status-failed">{t('discovery.failed')}</p>
        {#if discoveryStatus.completedAt !== null}
          <p class="status-muted">
            <time
              datetime={discoveryStatus.completedAt}
              title={discoveryStatus.completedAt}
            >{formatDateTime(discoveryStatus.completedAt, displayLocale)}</time>
          </p>
        {/if}
      {:else if discoveryStatus.kind === 'succeeded'}
        <p class="status-muted">
          {#if discoveryStatus.completedAt === null}
            {t('discovery.finished')}
          {:else}
            {t('discovery.last-search')}
            <time
              datetime={discoveryStatus.completedAt}
              title={discoveryStatus.completedAt}
            >{formatDateTime(discoveryStatus.completedAt, displayLocale)}</time>
          {/if}
        </p>
      {:else if discoveryStatus.kind === 'none'}
        <p class="status-muted">{t('discovery.never')}</p>
      {/if}
    </div>
  </div>

  {#if (pageState.snapshot?.devices.length ?? 0) > 0}
    <ul>
      {#each pageState.snapshot?.devices ?? [] as device (device.deviceId)}
        <li>
          <mndw-button
            variant="ghost"
            class="device-card-button"
            class:selected={pageState.selectedDeviceId === device.deviceId}
            data-testid={`device-${device.deviceId}`}
            data-device-id={device.deviceId}
            aria-pressed={pageState.selectedDeviceId === device.deviceId}
            onclick={() => onSelect(device.deviceId)}
          >
            <span class="device-card">
              <span class="device-content">
                <span class="device-name">{deviceTitle(device, usbInfo)}</span>
                <span class="device-path">{deviceMetadata(device)}</span>
                {#if device.sample === null}
                  <span
                    class="status-chip"
                    data-testid={`not-read-${device.deviceId}`}
                  >{t('read.not-yet')}</span>
                {:else}
                  <span
                    class="status-chip"
                    data-level={device.sample.assessment.level}
                    data-testid={`health-${device.deviceId}`}
                  >
                    {chipLabel(device.sample)}
                  </span>
                {/if}
              </span>
              <span
                class="device-indicator"
                aria-hidden="true"
              >›</span>
            </span>
          </mndw-button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if pageState.snapshot?.truncated}
    <p class="truncation-notice">{t('devices.truncated')}</p>
  {/if}
  {#if pageState.snapshot?.disconnectedTruncated}
    <p class="truncation-notice">{t('devices.disconnected-truncated')}</p>
  {/if}
</section>

<style>
.device-list {
  display: grid;
  gap: var(--mndw-space-4);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

/* Same height as the details header, which holds the read button. The backend status only shows when the backend is
   not available, and then grows the row. */
.heading {
  display: grid;
  gap: var(--mndw-space-1);
  align-items: center;
  min-height: var(--smart-header-min-h);
}

/* Flat on purpose: the cards under it are bordered, raised and clickable, this block is none of those. */
.discovery-panel {
  display: grid;
  gap: var(--mndw-space-2);
  justify-items: start;
  padding: var(--mndw-space-3);
  border-radius: var(--mndw-radius-md);
  background: var(--mndw-surface);
}

/* Two lines of the status font are always reserved, so no status moves the cards below. */
.discovery-status {
  align-self: stretch;
  min-height: calc(2 * var(--mndw-leading) * 1em);
  font-size: var(--mndw-text-sm);
  line-height: var(--mndw-leading);
}

.status-running {
  display: flex;
  gap: var(--mndw-space-2);
  align-items: center;
  color: var(--mndw-text-muted);
}

.status-progress {
  flex: 0 0 auto;
  width: calc(2 * var(--mndw-space-6));
}

.status-muted {
  color: var(--mndw-text-muted);
}

.status-failed {
  color: var(--mndw-danger);
}

h2,
p {
  margin: 0;
}

h2 {
  font-weight: var(--mndw-weight-semibold);
  font-size: var(--mndw-text-lg);
}

h2:focus-visible {
  outline: var(--mndw-focus-w) solid var(--mndw-focus-ring);
  outline-offset: var(--mndw-space-1);
}

.device-path {
  color: var(--mndw-text-muted);
  font-weight: var(--mndw-weight-normal);
  font-size: var(--mndw-text-sm);
}

ul {
  display: grid;
  gap: var(--mndw-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.device-card-button {
  width: 100%;
}

.device-card-button::part(button) {
  justify-content: flex-start;
  width: 100%;
  height: auto;
  min-height: var(--mndw-control-h);
  padding: var(--mndw-space-3);
  border: var(--mndw-border-w) solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  background: var(--mndw-surface-raised);
  text-align: left;
  white-space: normal;
}

.device-card-button:hover::part(button) {
  border-color: var(--mndw-text-subtle);
}

.device-card-button.selected::part(button) {
  border: 2px solid var(--mndw-accent);
}

.device-name,
.device-path {
  display: block;
  overflow-wrap: anywhere;
}

.device-card {
  display: flex;
  gap: var(--mndw-space-3);
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.device-content {
  display: grid;
  gap: var(--mndw-space-1);
  min-width: 0;
}

.device-indicator {
  flex: 0 0 auto;
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-lg);
}

.device-name {
  font-weight: var(--mndw-weight-semibold);
}

.status-chip {
  display: inline-block;
  width: fit-content;
  margin-top: var(--mndw-space-1);
  padding: 0 var(--mndw-space-2);
  border: var(--mndw-border-w) solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.status-chip[data-level='normal'] {
  border-color: var(--mndw-success);
  background: var(--mndw-success-bg);
  color: var(--mndw-text);
}

.status-chip[data-level='warning'] {
  border-color: var(--mndw-warning);
  background: var(--mndw-warning-bg);
  color: var(--mndw-text);
}

.status-chip[data-level='critical'] {
  border-color: var(--mndw-danger);
  background: var(--mndw-danger-bg);
  color: var(--mndw-text);
}

.truncation-notice {
  padding: var(--mndw-space-3);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  background: var(--mndw-surface-raised);
  color: var(--mndw-warning);
}
</style>
