<script lang="ts">
import {onMount} from 'svelte';
import type {PluginContext, RciQuery, Switchport} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';
import PortColumn from './components/PortColumn.svelte';
import {openRenameDialog} from './open-rename-dialog.js';
import {openSettingsDialog} from './open-settings-dialog.js';
import {formatAgo, timeAgo} from './model/ago.js';
import {describePort} from './model/describe-port.js';
import {hasWarning, portWarning} from './model/health.js';
import {type Rates, computeRates} from './model/rates.js';
import {buildRows} from './model/rows.js';
import {
  DEFAULT_SETTINGS,
  type WidgetSettings,
  parseSettings,
} from './model/settings.js';
import {parseMaxSpeedMbps} from './rci/parse-capabilities.js';
import {type Counters, parseCounters} from './rci/parse-counters.js';
import {type LinkInfo, parseInterface} from './rci/parse-interface.js';
import {parseHotspotDevices} from './rci/parse-port-data.js';
import {
  readPortDescriptions,
  writePortDescription,
} from './rci/port-description.js';
import {
  capabilitiesQuery,
  hotspotQuery,
  linkQuery,
  statQuery,
} from './rci/queries.js';

let {context}: {context: PluginContext} = $props();

// svelte-ignore state_referenced_locally
const translator = createTranslator(context.i18n);
// svelte-ignore state_referenced_locally
const inventory = context.device.info.switchports;
// svelte-ignore state_referenced_locally
const tooltipIdPrefix = `ports-tooltip-${context.instanceId}`;
const SETTINGS_KEY = 'line-settings';
const POLL_MS = 5000;

let links = $state<Record<string, LinkInfo>>({});
let counters = $state<Record<string, Counters>>({});
let rates = $state<Record<string, Rates | null>>({});
let maxSpeeds = $state<Record<string, number>>({});
let descriptions = $state<Record<string, string>>({});
let hotspotDevices = $state<Record<string, string[]>>({});
let settings = $state<WidgetSettings>(DEFAULT_SETTINGS);
let portFocusId = $state<string | null>(null);
let descriptionFocusId = $state<string | null>(null);
let focusedPortId = $state<string | null>(null);
let hoveredPortId = $state<string | null>(null);
let tooltipPortId = $state<string | null>(null);
let stale = $state(false);

const rows = $derived.by(() => buildRows(inventory.layout, inventory.list));
const ports = $derived.by(() => rows.flatMap((row) => row.ports));
const isEmpty = $derived(inventory.list.length === 0);
const positions = $derived.by(() => {
  const list: Array<{port: Switchport; row: number; column: number}> = [];

  rows.forEach((row, rowIndex) => {
    row.ports.forEach((port, column) => {
      list.push({port, row: rowIndex, column});
    });
  });

  return list;
});
const portTooltipCandidate = $derived(focusedPortId ?? hoveredPortId);

let disposed = false;
let polling = false;
let hotspotRequest = 0;

async function readCapabilities(): Promise<void> {
  if (ports.length === 0) {
    return;
  }

  try {
    const replies = await context.device.rci.query(
      ports.map((port) => capabilitiesQuery(port)),
    );

    if (disposed) {
      return;
    }

    const next = {...maxSpeeds};

    ports.forEach((port, index) => {
      const maximum = parseMaxSpeedMbps(replies[index]);

      if (maximum !== null) {
        next[port.id] = maximum;
      }
    });

    maxSpeeds = next;
  } catch {
    // The maximum speed only refines the warning; the port view works without it.
  }
}

async function readDescriptions(): Promise<void> {
  try {
    const next = await readPortDescriptions(context.device.rci);

    if (!disposed) {
      descriptions = next;
    }
  } catch {
    // Port names are optional; the rest of the widget remains useful without them.
  }
}

function loadSettings(): void {
  void context.storage.instance.get(SETTINGS_KEY)
    .then((value) => {
      if (disposed || value === null) {
        return;
      }

      try {
        settings = parseSettings(JSON.parse(value) as unknown);
      } catch {
        settings = DEFAULT_SETTINGS;
      }
    })
    .catch(() => undefined);
}

function updateSettings(next: WidgetSettings): void {
  settings = next;
  void context.storage.instance.set(SETTINGS_KEY, JSON.stringify(next)).catch(
    () => undefined,
  );
}

function openSettings(): void {
  openSettingsDialog(context, settings, $translator, updateSettings);
}

async function saveName(
  port: Switchport,
  value: string | null,
): Promise<string | null> {
  try {
    await writePortDescription(context.device.rci, port.interfaceId, value);
    descriptions = await readPortDescriptions(context.device.rci);
    context.toast.success($translator.t('details.saved'), {
      key: 'port-name-saved',
    });

    return null;
  } catch (error) {
    return error instanceof Error && error.message !== ''
      ? error.message
      : $translator.t('details.nameFailed');
  }
}

function openRename(port: Switchport): void {
  openRenameDialog(
    context,
    port.label,
    descriptions[port.interfaceId] ?? null,
    $translator,
    (value) => saveName(port, value),
  );
}

function closeTooltip(): void {
  if (tooltipPortId === null) {
    return;
  }

  tooltipPortId = null;
  hotspotDevices = {};
  hotspotRequest += 1;
}

function fetchHotspot(portId: string): void {
  const requestId = ++hotspotRequest;

  void context.device.rci.query([hotspotQuery()])
    .then((replies) => {
      if (
        !disposed && tooltipPortId === portId && hotspotRequest === requestId
      ) {
        hotspotDevices = parseHotspotDevices(replies[0]);
      }
    })
    .catch(() => undefined);
}

function showTooltip(portId: string): void {
  if (links[portId]?.status !== 'up' || tooltipPortId === portId) {
    return;
  }

  closeTooltip();
  tooltipPortId = portId;
  fetchHotspot(portId);
}

function syncTooltip(nextLinks: Record<string, LinkInfo>): void {
  const candidate = portTooltipCandidate ?? tooltipPortId;

  if (candidate !== null && nextLinks[candidate]?.status === 'up') {
    showTooltip(candidate);
  } else if (
    tooltipPortId !== null && nextLinks[tooltipPortId]?.status !== 'up'
  ) {
    closeTooltip();
  }
}

async function poll(): Promise<void> {
  if (disposed || polling || ports.length === 0) {
    return;
  }

  polling = true;

  try {
    const requests: RciQuery[] = [];
    const targets: Array<{port: Switchport; counter: boolean}> = [];

    for (const port of ports) {
      requests.push(linkQuery(port));
      targets.push({port, counter: false});

      if (inventory.hasPortStats) {
        requests.push(statQuery(port));
        targets.push({port, counter: true});
      }
    }

    const hotspotIndex = tooltipPortId === null ? null : requests.length;

    if (hotspotIndex !== null) {
      requests.push(hotspotQuery());
    }

    const replies = await context.device.rci.query(requests);

    if (disposed) {
      return;
    }

    const nextLinks = {...links};
    const nextCounters = {...counters};
    const nextRates = {...rates};

    targets.forEach((target, index) => {
      const reply = replies[index];

      if (target.counter) {
        const parsed = parseCounters(reply, target.port.interfaceId);

        if (parsed !== null) {
          nextRates[target.port.id] = computeRates(
            nextCounters[target.port.id] ?? null,
            parsed,
          );
          nextCounters[target.port.id] = parsed;
        }
      } else {
        const parsed = parseInterface(reply);

        if (parsed !== null) {
          nextLinks[target.port.id] = parsed;
        }
      }
    });

    links = nextLinks;
    counters = nextCounters;
    rates = nextRates;
    if (hotspotIndex !== null && tooltipPortId !== null) {
      hotspotDevices = parseHotspotDevices(replies[hotspotIndex]);
    }
    stale = false;
    syncTooltip(nextLinks);
  } catch {
    if (!disposed) {
      stale = true;
    }
  } finally {
    polling = false;
  }
}

function scrollFocusedElement(element: HTMLElement): void {
  element.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
}

function onPortFocus(port: Switchport, element: HTMLElement): void {
  portFocusId = port.id;
  focusedPortId = port.id;
  scrollFocusedElement(element);
  showTooltip(port.id);
}

function onPortBlur(portId: string): void {
  if (focusedPortId === portId) {
    focusedPortId = null;
  }

  if (hoveredPortId === null) {
    closeTooltip();
  } else {
    showTooltip(hoveredPortId);
  }
}

function onPointerEnter(portId: string): void {
  hoveredPortId = portId;
  showTooltip(portId);
}

function onPointerLeave(portId: string): void {
  if (hoveredPortId === portId) {
    hoveredPortId = null;
  }

  if (focusedPortId === null) {
    closeTooltip();
  } else {
    showTooltip(focusedPortId);
  }
}

function moveFocus(
  event: KeyboardEvent,
  portId: string,
  descriptionRow: boolean,
): void {
  const keys = [
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
  ];

  if (!keys.includes(event.key)) {
    return;
  }

  const index = positions.findIndex((position) => position.port.id === portId);

  if (index < 0) {
    return;
  }

  const current = positions[index];
  let targetIndex = index;

  if (event.key === 'Home') {
    targetIndex = 0;
  } else if (event.key === 'End') {
    targetIndex = positions.length - 1;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    targetIndex = Math.max(0, index - 1);
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    targetIndex = Math.min(positions.length - 1, index + 1);
  }

  if (targetIndex === index) {
    return;
  }

  event.preventDefault();
  const target = positions[targetIndex].port;
  const widget = (event.currentTarget as HTMLElement | null)?.closest(
    '[data-ports-widget]',
  );
  const selector = descriptionRow ? '.description' : '.port-trigger';
  const candidates = widget?.querySelectorAll<HTMLElement>(selector) ?? [];

  for (const candidate of candidates) {
    if (
      candidate.closest<HTMLElement>('[data-port-id]')?.dataset.portId
        === target.id
    ) {
      if (descriptionRow) {
        descriptionFocusId = target.id;
      } else {
        portFocusId = target.id;
      }

      candidate.focus();
      scrollFocusedElement(candidate);

      return;
    }
  }
}

onMount(() => {
  if (isEmpty) {
    return;
  }

  void readCapabilities();
  void readDescriptions();
  void poll();
  loadSettings();

  const ticker = context.timers.createTicker();
  const subscription = ticker.tick$.subscribe(() => {
    void poll();
  });

  ticker.start(POLL_MS);

  return () => {
    disposed = true;
    subscription.unsubscribe();
    ticker.stop();
    hotspotRequest += 1;
  };
});
</script>

<div
  class="ports"
  role="group"
  aria-label={$translator.t('title')}
  data-ports-widget=""
>
  {#if !isEmpty}
    <div class="widget-header">
      <button
        type="button"
        class="settings-button"
        aria-label={$translator.t('settings.open')}
        onclick={openSettings}
      >
        <mndw-icon name="settings"></mndw-icon>
      </button>
    </div>
  {/if}
  {#if isEmpty}
    <p
      class="empty"
      role="status"
    >
      {$translator.t('empty')}
    </p>
  {:else}
    <div class="rows-scroll">
      <div
        class="port-grid"
        role="group"
        aria-label={$translator.t('ports')}
        style={`--columns: ${
          Math.max(...rows.map((row) => row.ports.length), 1)
        };`}
      >
        {#each rows as row, rowIndex (rowIndex)}
          <div
            class="physical-row"
            data-row={rowIndex}
            style={`--cell-rows: ${settings.rows.length + 1};`}
          >
            {#each row.ports as port, columnIndex (port.id)}
              {@const link = links[port.id] ?? null}
              {@const maxSpeed = maxSpeeds[port.id] ?? null}
              {@const description = descriptions[port.interfaceId] ?? null}
              {@const warning = hasWarning(portWarning(link, maxSpeed))}
              {@const changed = timeAgo(link?.lastChangeSeconds ?? null)}
              <PortColumn
                {port}
                {columnIndex}
                rowKinds={settings.rows}
                status={link?.status ?? 'unknown'}
                {link}
                counters={counters[port.id] ?? null}
                rates={rates[port.id] ?? null}
                {description}
                devices={hotspotDevices[port.label] ?? []}
                showStats={inventory.hasPortStats}
                {warning}
                maxSpeedMbps={maxSpeed}
                name={describePort(
                  port,
                  link,
                  maxSpeed,
                  $translator,
                  description,
                )}
                tooltipOpen={tooltipPortId === port.id}
                tooltipId={`${tooltipIdPrefix}-${port.id}`}
                changedLabel={changed === null ? null : formatAgo(changed, $translator)}
                translator={$translator}
                portTabIndex={port.id === (portFocusId ?? positions[0]?.port.id)
                ? 0
                : -1}
                descriptionTabIndex={port.id === (descriptionFocusId ?? positions[0]?.port.id)
                ? 0
                : -1}
                onportfocus={(element) => onPortFocus(port, element)}
                onportblur={() => onPortBlur(port.id)}
                onportkeydown={(event) => moveFocus(event, port.id, false)}
                onportclick={() => showTooltip(port.id)}
                onpointerenter={() => onPointerEnter(port.id)}
                onpointerleave={() => onPointerLeave(port.id)}
                onrename={() => openRename(port)}
                ondescriptionkeydown={(event) => moveFocus(event, port.id, true)}
              />
            {/each}
          </div>
        {/each}
      </div>
    </div>
    {#if stale}
      <p
        class="stale"
        role="status"
      >
        <mndw-icon name="circle-alert"></mndw-icon>
        {$translator.t('stale')}
      </p>
    {/if}
  {/if}
</div>

<style>
.ports {
  display: flex;
  flex-direction: column;
  gap: var(--mndw-space-2);
  height: 100%;
  min-height: 0;
  overflow: auto;
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

.widget-header {
  display: flex;
  height: 1.75rem;
  flex: none;
  justify-content: flex-end;
}

.settings-button {
  display: inline-flex;
  width: 1.75rem;
  height: 1.75rem;
  align-items: center;
  justify-content: center;
  color: var(--mndw-text-muted);
  background: none;
  border: 0;
  border-radius: var(--mndw-radius-sm);
  cursor: pointer;
}

.settings-button:hover {
  color: var(--mndw-text);
  background: var(--mndw-surface-hover);
}

.settings-button:focus-visible {
  outline: var(--mndw-focus-w) solid var(--mndw-focus-ring);
  outline-offset: 1px;
}

.rows-scroll {
  width: 100%;
  min-width: 0;
  overflow: auto;
}

.port-grid {
  display: inline-grid;
  grid-template-columns: repeat(var(--columns), 1fr);
  gap: var(--mndw-space-3);
  width: max-content;
}

.physical-row {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  grid-template-rows: repeat(var(--cell-rows), auto);
}

.empty {
  margin: 0;
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.stale {
  display: flex;
  gap: var(--mndw-space-1);
  align-items: center;
  margin: 0;
  color: var(--mndw-warning);
  font-size: var(--mndw-text-sm);
}
</style>
