<script lang="ts">
import {computeTooltipCoords} from '@mndw/ui';
import type {Switchport} from '@mndw/sdk';
import type {Translator} from '@mndw/sdk/svelte';
import {formatBitRate, formatBytes} from '../model/bytes.js';
import {formatPortSpeed, formatSpeed} from '../model/speed.js';
import type {RowKind} from '../model/settings.js';
import type {Rates} from '../model/rates.js';
import type {Counters} from '../rci/parse-counters.js';
import type {LinkInfo, LinkStatus} from '../rci/parse-interface.js';

let {
  port,
  columnIndex,
  rowKinds,
  status,
  link,
  counters,
  rates,
  description,
  devices,
  showStats,
  warning,
  maxSpeedMbps,
  name,
  tooltipOpen,
  tooltipId,
  changedLabel,
  translator,
  portTabIndex,
  descriptionTabIndex,
  onportfocus,
  onportblur,
  onportkeydown,
  onportclick,
  onpointerenter,
  onpointerleave,
  onrename,
  ondescriptionkeydown,
}: {
  port: Switchport;
  columnIndex: number;
  rowKinds: readonly RowKind[];
  status: LinkStatus;
  link: LinkInfo | null;
  counters: Counters | null;
  rates: Rates | null;
  description: string | null;
  devices: readonly string[];
  showStats: boolean;
  warning: boolean;
  maxSpeedMbps: number | null;
  name: string;
  tooltipOpen: boolean;
  tooltipId: string;
  changedLabel: string | null;
  translator: Translator;
  portTabIndex: number;
  descriptionTabIndex: number;
  onportfocus: (element: HTMLElement) => void;
  onportblur: () => void;
  onportkeydown: (event: KeyboardEvent) => void;
  onportclick: () => void;
  onpointerenter: () => void;
  onpointerleave: () => void;
  onrename: () => void;
  ondescriptionkeydown: (event: KeyboardEvent) => void;
} = $props();

let portTrigger: HTMLElement | null = $state(null);
let tooltip: HTMLElement | null = $state(null);
let tooltipPositioned = $state(false);
const MISSING_VALUE = '—';

const portType = $derived(
  port.type === 'ethernet' || port.type === 'sfp' || port.type === 'dsl'
    ? port.type
    : 'ethernet',
);
const combo = $derived(
  port.isCombo
    ? (port.isComboInverted ? 'sfp-ethernet' : 'ethernet-sfp')
    : 'none',
);

function rowValue(kind: RowKind): string {
  switch (kind) {
    case 'description':
      return description ?? '';
    case 'speed':
      if (status !== 'up' || link?.speedMbps == null) {
        return MISSING_VALUE;
      }

      return formatPortSpeed(link.speedMbps, translator);
    case 'duplex':
      return status === 'up' && link?.duplex !== null
          && link?.duplex !== undefined
        ? translator.t(`duplex.short.${link.duplex}`)
        : MISSING_VALUE;
    case 'rx-total':
      return showStats && counters?.rxBytes != null
        ? translator.t('row.rx-total', {
          value: formatBytes(counters.rxBytes, translator),
        })
        : MISSING_VALUE;
    case 'tx-total':
      return showStats && counters?.txBytes != null
        ? translator.t('row.tx-total', {
          value: formatBytes(counters.txBytes, translator),
        })
        : MISSING_VALUE;
    case 'rx-rate':
      return showStats && rates?.rxBitsPerSecond != null
        ? translator.t('row.rx-rate', {
          value: formatBitRate(rates.rxBitsPerSecond, translator),
        })
        : MISSING_VALUE;
    case 'tx-rate':
      return showStats && rates?.txBitsPerSecond != null
        ? translator.t('row.tx-rate', {
          value: formatBitRate(rates.txBitsPerSecond, translator),
        })
        : MISSING_VALUE;
    case 'rx-errors':
      return showStats && counters?.rxErrors != null && counters.rxErrors > 0
        ? translator.t('row.rx-errors', {value: counters.rxErrors})
        : '';
    case 'tx-errors':
      return showStats && counters?.txErrors != null && counters.txErrors > 0
        ? translator.t('row.tx-errors', {value: counters.txErrors})
        : '';
    case 'rx-dropped':
      return showStats && counters?.rxDropped != null && counters.rxDropped > 0
        ? translator.t('row.rx-dropped', {value: counters.rxDropped})
        : '';
    case 'tx-dropped':
      return showStats && counters?.txDropped != null && counters.txDropped > 0
        ? translator.t('row.tx-dropped', {value: counters.txDropped})
        : '';
    case 'separator':
      return '';
  }
}

const currentName = $derived(
  description ?? translator.t('description.unnamed'),
);
const renameLabel = $derived(
  translator.t('description.rename', {label: port.label, name: currentName}),
);

$effect(() => {
  const open = tooltipOpen;
  const trigger = portTrigger;
  const bubble = tooltip;
  const content = [
    devices,
    description,
    changedLabel,
    maxSpeedMbps,
    showStats,
    counters?.rxBytes,
    counters?.txBytes,
    link?.speedMbps,
  ];

  if (
    !open || trigger === null || bubble === null
    || typeof window === 'undefined'
  ) {
    tooltipPositioned = false;

    return;
  }

  void content;

  const updatePosition = (): void => {
    const icon = trigger.querySelector('mndw-switchport');

    if (icon === null) {
      return;
    }

    const rect = bubble.getBoundingClientRect();
    const coords = computeTooltipCoords(
      icon.getBoundingClientRect(),
      {width: rect.width, height: rect.height},
      'bottom',
      {width: window.innerWidth, height: window.innerHeight},
    );

    bubble.style.left = `${coords.left}px`;
    bubble.style.top = `${coords.top}px`;
    tooltipPositioned = true;
  };

  updatePosition();
  window.addEventListener('scroll', updatePosition, true);
  window.addEventListener('resize', updatePosition);

  return () => {
    window.removeEventListener('scroll', updatePosition, true);
    window.removeEventListener('resize', updatePosition);
  };
});
</script>

<div
  class="port-column"
  class:warning
  data-port-id={port.id}
  style={`grid-row: 1 / -1; grid-column: ${columnIndex + 1};`}
>
  <div class="port-anchor">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="port-trigger"
      bind:this={portTrigger}
      class:up={status === 'up'}
      class:down={status === 'down'}
      role="img"
      tabindex={portTabIndex}
      aria-label={name}
      aria-describedby={tooltipOpen ? tooltipId : undefined}
      onfocus={(event) => onportfocus(event.currentTarget as HTMLElement)}
      onblur={onportblur}
      onkeydown={onportkeydown}
      onclick={onportclick}
      onpointerenter={onpointerenter}
      onpointerleave={onpointerleave}
    >
      <mndw-switchport
        type={portType}
        color={port.color}
        label={port.label}
        reversed={port.isReversed}
        combo={combo}
        active={link?.activeMedium ?? ''}
        link={status === 'up'}
        port-role={link?.role === 'inet' ? 'inet' : ''}
      ></mndw-switchport>
    </div>
    {#if tooltipOpen && status === 'up'}
      <div
        class="tooltip"
        class:positioned={tooltipPositioned}
        bind:this={tooltip}
        id={tooltipId}
        role="tooltip"
      >
        {#if showStats}
          <span>{rowValue('rx-total')}</span>
          <span>{rowValue('tx-total')}</span>
        {/if}
        {#if changedLabel !== null}
          <span>{translator.t('tooltip.changed', {ago: changedLabel})}</span>
        {/if}
        {#if maxSpeedMbps !== null && link?.speedMbps !== null
          && link?.speedMbps !== undefined
          && link.speedMbps < maxSpeedMbps}
          <span>{
            translator.t('tooltip.maximum', {
              max: formatSpeed(maxSpeedMbps, translator),
            })
          }</span>
        {/if}
        {#if description !== null}
          <strong class="tooltip-name">{description}</strong>
        {/if}
        {#if devices.length > 0}
          <span class="tooltip-heading">{translator.t('tooltip.devices')}</span>
          {#each devices as device (device)}<span>{device}</span>{/each}
        {/if}
      </div>
    {/if}
  </div>

  {#each rowKinds as kind, index (`${kind}-${index}`)}
    {#if kind === 'description'}
      <button
        type="button"
        class="cell description"
        data-description-button=""
        aria-label={renameLabel}
        title={description
        ? `${description} — ${
          translator.t('details.renameTitle', {label: port.label})
        }`
        : translator.t('details.renameTitle', {label: port.label})}
        tabindex={descriptionTabIndex}
        onclick={onrename}
        onkeydown={ondescriptionkeydown}
      >
        <span class="description-text">{description ?? ''}</span>
        {#if !description}
          <span
            class="description-placeholder"
            aria-hidden="true"
          >{translator.t('details.name')}</span>
        {/if}
        <mndw-icon
          name="pencil"
          aria-hidden="true"
        ></mndw-icon>
      </button>
    {:else if kind === 'separator'}
      <span
        class="cell separator"
        aria-hidden="true"
      ></span>
    {:else}
      {@const value = rowValue(kind)}
      <span
        class={`cell value ${kind}`}
        class:warning={kind === 'speed' && warning}
      >
        {#if kind === 'speed' && warning}
          <mndw-icon
            name="circle-alert"
            aria-hidden="true"
          ></mndw-icon>
        {/if}
        {#if value === MISSING_VALUE}
          <span
            class="missing-value"
            aria-hidden="true"
          >{value}</span>
        {:else}
          <span>{value}</span>
        {/if}
      </span>
    {/if}
  {/each}
</div>

<style>
.port-column {
  position: relative;
  z-index: 0;
  display: grid;
  grid-template-rows: subgrid;
  row-gap: var(--mndw-space-1);
  padding: 2px;
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

.port-column:hover,
.port-column:focus-within {
  z-index: 2;
}

.port-anchor {
  position: relative;
  display: flex;
  height: 3.2rem;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--mndw-space-1);
}

.port-trigger {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  border-radius: var(--mndw-radius-sm);
  cursor: pointer;
}

.port-trigger:focus-visible {
  outline: var(--mndw-focus-w) solid var(--mndw-focus-ring);
  outline-offset: 1px;
}

mndw-switchport {
  display: block;
  max-width: 100%;
  font-size: 0.9rem;
}

.cell {
  display: flex;
  width: 100%;
  box-sizing: border-box;
  min-height: 1.2em;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 0;
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-xs);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  white-space: nowrap;
}

.description {
  position: relative;
  width: 100%;
  min-width: 0;
  contain: inline-size;
  box-sizing: border-box;
  height: calc(2.4em + 4px);
  overflow: hidden;
  padding: 2px;
  text-align: center;
  white-space: normal;
  background: none;
  border: 0;
  cursor: pointer;
}

.description:hover,
.description:focus {
  color: var(--mndw-text);
  background: var(--mndw-control-hover);
  outline: 1px solid var(--mndw-accent);
}

.description:focus-visible {
  outline: var(--mndw-focus-w) solid var(--mndw-focus-ring);
  outline-offset: 1px;
  box-shadow: inset 0 0 0 1px var(--mndw-accent);
}

:global(:where(.rows-scroll:hover .description, .rows-scroll:has(.description:focus) .description)) {
  outline: 1px dashed var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
}

.description-text {
  width: 100%;
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  text-overflow: ellipsis;
  white-space: normal;
}

.description-placeholder {
  position: absolute;
  top: 50%;
  left: 50%;
  right: auto;
  color: var(--mndw-text-muted);
  visibility: hidden;
  transform: translate(-50%, -50%);
}

.description:hover .description-placeholder,
.description:focus .description-placeholder {
  visibility: visible;
}

.description mndw-icon {
  position: absolute;
  top: 3px;
  right: 3px;
  z-index: 1;
  box-sizing: border-box;
  padding: 2px;
  background: var(--mndw-control-hover);
  border-radius: var(--mndw-radius-sm);
  opacity: 0;
}

.description:hover mndw-icon,
.description:focus mndw-icon {
  opacity: 1;
}

.value {
  width: 100%;
}

.speed.warning {
  color: var(--mndw-warning);
}

.value .missing-value {
  color: var(--mndw-text-muted);
}

.separator {
  min-height: var(--mndw-space-2);
}

.tooltip {
  position: fixed;
  z-index: 1000;
  top: 0;
  left: 0;
  display: flex;
  width: max-content;
  min-width: 0;
  max-width: min(18rem, calc(100vw - 1rem));
  max-height: calc(100vh - 1rem);
  box-sizing: border-box;
  flex-direction: column;
  gap: var(--mndw-space-1);
  padding: var(--mndw-space-1) var(--mndw-space-2);
  overflow-y: auto;
  overflow-wrap: anywhere;
  color: var(--mndw-text);
  text-align: left;
  white-space: normal;
  font-size: var(--mndw-text-xs);
  line-height: var(--mndw-leading);
  background: var(--mndw-surface-raised);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
  box-shadow: var(--mndw-shadow-2);
}

.tooltip:not(.positioned) {
  visibility: hidden;
}

.tooltip-name,
.tooltip-heading {
  font-weight: var(--mndw-weight-semibold);
}

.tooltip-heading {
  margin-top: var(--mndw-space-2);
}

@media (hover: none) {
  .description {
    outline: 1px dashed var(--mndw-border);
    border-radius: var(--mndw-radius-sm);
  }

  .description-placeholder {
    visibility: visible;
  }

  .description mndw-icon {
    opacity: 1;
  }
}
</style>
