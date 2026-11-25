<script lang="ts">
import {onMount, tick, untrack} from 'svelte';
import type {PluginContext} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';
import DeviceDetails from './components/DeviceDetails.svelte';
import DeviceList from './components/DeviceList.svelte';
import Diagnostics from './components/Diagnostics.svelte';
import NoDevices from './components/NoDevices.svelte';
import {
  type PageViewChoice,
  type PageViewName,
  effectiveView,
} from './components/page-view';
import PageNotice from './components/PageNotice.svelte';
import {confirmWake} from './services/confirm-wake';
import {PageController, type PageState} from './services/page-controller';
import {SmartClient} from './services/smart-client';
import {type UsbInfoMap, readUsbInfo} from './services/usb-info';

let {context}: {context: PluginContext} = $props();
// svelte-ignore state_referenced_locally
const translator = createTranslator(context.i18n);
// svelte-ignore state_referenced_locally
const controller = new PageController(new SmartClient(context.backend), {
  wakeConsentStorage: context.storage.shared,
  onDiscoverAccepted: () => void reloadUsbInfo(),
});
let state = $state<PageState>(controller.getState());
// svelte-ignore state_referenced_locally
let locale = $state(context.i18n.locale);
let usbInfo = $state<UsbInfoMap>(new Map());
let usbAbort: AbortController | null = null;
let usbReadVersion = 0;
let viewChoice = $state<PageViewChoice>(null);
let list: DeviceList | undefined = $state();
let details: DeviceDetails | undefined = $state();
let noDevices: NoDevices | undefined = $state();
let backRow: HTMLElement | null = $state(null);
let page: HTMLElement | null = null;
let detailColumn: HTMLElement | null = $state(null);
let listColumn: HTMLElement | null = $state(null);
let focusInPage = false;
let focusInDetails = false;
let focusInList = false;
let previousHasList: boolean | null = null;
let previousView: PageViewName | null = null;

// The list is shown while it has drives or a search is filling it; otherwise one centered block explains why not.
const hasList = $derived.by((): boolean => {
  return (state.snapshot?.devices.length ?? 0) > 0
    || state.emptyState?.kind === 'searching';
});
const view = $derived.by(() => {
  return effectiveView({
    choice: viewChoice,
    deviceCount: state.snapshot?.devices.length ?? 0,
    hasSelectedDevice: state.snapshot?.devices.some((device) =>
      device.deviceId === state.selectedDeviceId
    ) ?? false,
  });
});
const selectedPresent = $derived.by((): boolean => {
  return state.snapshot?.devices.some((device) =>
    device.deviceId === state.selectedDeviceId
  ) ?? false;
});
// The failed block already says what went wrong, so the same notice is not repeated above it.
const notice = $derived.by(() => {
  const empty = state.emptyState;

  return empty?.kind === 'failed' && state.notice?.kind === 'request-error'
      && state.notice.code === empty.code
    ? null
    : state.notice;
});

// Focus must survive a swap or a removal that destroys the element holding it, so it is noted before the DOM changes.
$effect.pre(() => {
  void hasList;
  void selectedPresent;
  void view;
  focusInPage = page?.contains(document.activeElement) ?? false;
  focusInDetails = detailColumn?.contains(document.activeElement) ?? false;
  focusInList = listColumn?.contains(document.activeElement) ?? false;
});

$effect(() => {
  const listShown = hasList;
  const present = selectedPresent;

  untrack(() => {
    const swapped = previousHasList !== null && previousHasList !== listShown;

    previousHasList = listShown;

    // The opened drive left the snapshot: a drive that comes back must not reopen its details by itself.
    if (!present && viewChoice === 'details') { viewChoice = 'list'; }

    if (swapped && focusInPage) {
      void tick().then(
        () => (listShown ? list?.focusHeading() : noDevices?.focusHeading()),
      );
    } else if (!present && focusInDetails && listShown) {
      void tick().then(() => list?.focusHeading());
    }
  });
});

// A single drive found while focus sits in the list turns the narrow view to its details without any user choice.
$effect(() => {
  const current = view;

  untrack(() => {
    const opened = previousView === 'list' && current === 'details'
      && viewChoice === null;

    previousView = current;

    if (opened && focusInList && isNarrow()) {
      void tick().then(() => details?.focusHeading());
    }
  });
});

// Only the narrow layout shows the back row; there focus has to follow the view change.
function isNarrow(): boolean {
  return backRow !== null && getComputedStyle(backRow).display !== 'none';
}

async function openDetails(deviceId: string): Promise<void> {
  viewChoice = 'details';
  controller.selectDevice(deviceId);
  await tick();

  if (isNarrow()) { details?.focusHeading(); }
}

async function backToList(): Promise<void> {
  const deviceId = state.selectedDeviceId;

  viewChoice = 'list';
  await tick();

  if (deviceId !== null) { list?.focusDevice(deviceId); }
}

async function reloadUsbInfo(): Promise<void> {
  const abort = usbAbort;

  if (abort === null) { return; }

  const version = ++usbReadVersion;
  const info = await readUsbInfo(context.device.rci, abort.signal);

  if (!abort.signal.aborted && version === usbReadVersion) {
    usbInfo = info;
  }
}

async function discover(
  targetDeviceId: string | undefined,
): Promise<'accepted' | 'rejected'> {
  return await controller.discover(targetDeviceId);
}

onMount(() => {
  usbAbort = new AbortController();
  void reloadUsbInfo();
  const unsubscribe = controller.subscribe((nextState) => {
    state = nextState;
  });
  const localeSubscription = context.i18n.locale$.subscribe((nextLocale) => {
    locale = nextLocale;
  });
  const updateVisibility = (): void => {
    controller.setVisible(document.visibilityState === 'visible');
  };

  document.addEventListener('visibilitychange', updateVisibility);
  controller.start();

  return () => {
    usbReadVersion += 1;
    usbAbort?.abort();
    usbAbort = null;
    localeSubscription.unsubscribe();
    document.removeEventListener('visibilitychange', updateVisibility);
    unsubscribe();
    controller.stop();
  };
});
</script>

<div
  class="page"
  bind:this={page}
>
  <h1>{$translator.t('title')}</h1>
  <PageNotice
    {notice}
    i18n={$translator}
  />
  {#if hasList}
    <div
      class="layout"
      data-testid="layout"
      data-view={view}
    >
      <div
        class="list-column"
        bind:this={listColumn}
      >
        <DeviceList
          bind:this={list}
          {state}
          i18n={$translator}
          {locale}
          {usbInfo}
          onDiscover={discover}
          onSelect={(deviceId) => void openDetails(deviceId)}
        />
      </div>
      <div
        class="detail-column"
        bind:this={detailColumn}
      >
        <div
          class="back-row"
          bind:this={backRow}
        >
          <mndw-button
            variant="ghost"
            data-testid="back-to-list"
            onclick={() => void backToList()}
          >{$translator.t('action.back-to-list')}</mndw-button>
        </div>
        <DeviceDetails
          bind:this={details}
          {state}
          i18n={$translator}
          {locale}
          {usbInfo}
          onDiscover={discover}
          onRefresh={(targetDeviceId, rememberConsent) =>
          controller.refresh(true, targetDeviceId, rememberConsent)}
          onSetDeviceType={(targetDeviceId, deviceType) =>
          controller.setDeviceType(deviceType, targetDeviceId)}
          onFocusLost={() => list?.focusHeading()}
          confirmWake={(canRemember, signal) =>
          confirmWake(context.overlay, $translator, {canRemember,
            signal})}
        />
      </div>
    </div>
    {#if state.snapshot !== null}
      <Diagnostics
        snapshot={state.snapshot}
        i18n={$translator}
        {locale}
      />
    {/if}
  {:else}
    <div class="single-column">
      <NoDevices
        bind:this={noDevices}
        {state}
        i18n={$translator}
        {usbInfo}
        onDiscover={discover}
      />
      {#if state.snapshot !== null}
        <Diagnostics
          snapshot={state.snapshot}
          i18n={$translator}
          {locale}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
.page {
  container-type: inline-size;
  display: grid;
  gap: var(--mndw-space-5);
  max-width: 80rem;
  margin: 0 auto;
  padding: var(--mndw-space-4);
  color: var(--mndw-text);
  font-size: var(--mndw-text-md);
  font-family: var(--mndw-font-sans);
}

h1 {
  margin: 0;
  font-weight: var(--mndw-weight-semibold);
  font-size: var(--mndw-text-lg);
}

.layout {
  /* Both column headers (the list's and the details') take this height, so their titles share a line and the first
     block under each starts at the same y. */
  --smart-header-min-h: var(--mndw-control-h);

  display: grid;
  gap: var(--mndw-space-5);
}

.list-column,
.detail-column {
  display: grid;
  gap: var(--mndw-space-4);
  align-content: start;
  min-width: 0;
}

.single-column {
  display: grid;
  gap: var(--mndw-space-4);
  width: 100%;
  max-width: 32rem;
  margin: 0 auto;
}

/* The page sits beside the host sidebar, so the layout follows the page width, not the viewport. */
@container (width < 56rem) {
  .layout[data-view='list'] > .detail-column,
  .layout[data-view='details'] > .list-column {
    display: none;
  }
}

@container (width >= 56rem) {
  .layout {
    grid-template-columns: minmax(16rem, 20rem) minmax(0, 1fr);
    align-items: start;
  }

  .back-row {
    display: none;
  }
}
</style>
