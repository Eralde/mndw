<script lang="ts">
import {tick} from 'svelte';
import type {Translator} from '@mndw/sdk';
import type {Device, DeviceTypeOverride} from '../model/api';
import {formatNullable} from '../model/format';
import type {ActionResult} from '../services/page-controller';

interface Props {
  device: Device;
  i18n: Translator;
  disabled: boolean;
  isTargetCurrent: (deviceId: string) => boolean;
  onSetDeviceType: (
    deviceId: string,
    value: DeviceTypeOverride | null,
  ) => Promise<ActionResult>;
}

const DEVICE_TYPES: DeviceTypeOverride[] = [
  'sat',
  'scsi',
  'nvme',
  'sntasmedia',
  'sntjmicron',
  'sntrealtek',
];
let {device, i18n, disabled, isTargetCurrent, onSetDeviceType}: Props =
  $props();
let chosenDeviceType = $state<string | undefined>(undefined);
let manualReadHint = $state(false);
let pending = $state(false);
let selectControl: HTMLElement | null = $state(null);

const currentType = $derived.by((): string => {
  return device.deviceTypeSource === 'user'
      && DEVICE_TYPES.includes(device.deviceType as DeviceTypeOverride)
    ? device.deviceType
    : 'auto';
});
// The label the option list shows, so the line and the list name a type the same way; an unknown type stays raw.
const currentTypeLabel = $derived.by((): string => {
  return DEVICE_TYPES.includes(device.deviceType as DeviceTypeOverride)
    ? t(`device-type.option.${device.deviceType}`)
    : device.deviceType;
});
const selectedType = $derived.by((): string => chosenDeviceType ?? currentType);
const showConfirmation = $derived.by((): boolean => {
  return chosenDeviceType !== undefined && chosenDeviceType !== currentType;
});

function t(key: string): string {
  return i18n.t(key);
}

function choose(value: string): void {
  if (
    value !== 'auto' && !DEVICE_TYPES.includes(value as DeviceTypeOverride)
  ) { return; }
  chosenDeviceType = value === currentType ? undefined : value;
}

function cancel(): void {
  chosenDeviceType = undefined;
  selectControl?.focus();
}

async function apply(): Promise<void> {
  if (
    !showConfirmation || chosenDeviceType === undefined || disabled || pending
  ) { return; }

  const targetDeviceId = device.deviceId;

  if (!isTargetCurrent(targetDeviceId)) { return; }

  const value = chosenDeviceType === 'auto'
    ? null
    : chosenDeviceType as DeviceTypeOverride;

  pending = true;

  try {
    const result = await onSetDeviceType(targetDeviceId, value);

    if (result === 'accepted' && isTargetCurrent(targetDeviceId)) {
      chosenDeviceType = undefined;
      manualReadHint = true;
    }
  } finally {
    pending = false;
    await tick();

    if (
      selectControl !== null && !disabled && isTargetCurrent(targetDeviceId)
    ) {
      selectControl.focus();
    }
  }
}
</script>

<section
  class="device-type"
  aria-labelledby="device-type-title"
>
  <h3 id="device-type-title">{t('details.device-type')}</h3>
  <p>{t('device-type.current')}: {currentTypeLabel}</p>
  <p>{t(`device-type.source.${device.deviceTypeSource}`)}</p>
  <p>{t('device-type.usb-bridge')}: {formatNullable(device.usbBridge)}</p>
  <mndw-select
    bind:this={selectControl}
    label={t('device-type.override-label')}
    value={selectedType}
    disabled={disabled || pending}
    onmndwchange={(event: CustomEvent<{value: string}>) => choose(event.detail.value)}
  >
    <mndw-option value="auto">{t('device-type.auto')}</mndw-option>
    {#each DEVICE_TYPES as type (type)}
      <mndw-option value={type}>{t(`device-type.option.${type}`)}</mndw-option>
    {/each}
  </mndw-select>
  {#if showConfirmation}
    <div
      class="type-warning"
      role="alert"
    >
      <p>{t('device-type.warning')}</p>
      <p>{t('device-type.bridge-hint')}</p>
      <div class="actions">
        <mndw-button
          variant="secondary"
          data-testid="cancel-device-type"
          disabled={pending}
          onclick={cancel}
        >{t('action.cancel')}</mndw-button>
        <mndw-button
          variant="primary"
          data-testid="confirm-device-type"
          disabled={disabled || pending}
          onclick={() => void apply()}
        >
          {t('device-type.confirm')}
        </mndw-button>
      </div>
    </div>
  {/if}
  {#if manualReadHint}
    <p class="manual-read-hint">{t('device-type.manual-read-hint')}</p>
  {/if}
</section>

<style>
.device-type,
.type-warning {
  display: grid;
  gap: var(--mndw-space-2);
  padding: var(--mndw-space-3);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  background: var(--mndw-surface-raised);
}

.device-type h3,
.device-type p,
.type-warning p {
  margin: 0;
}

.device-type h3 {
  font-weight: var(--mndw-weight-semibold);
  font-size: var(--mndw-text-md);
}

.type-warning {
  border-color: var(--mndw-warning);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
}

.manual-read-hint {
  color: var(--mndw-text-muted);
}
</style>
