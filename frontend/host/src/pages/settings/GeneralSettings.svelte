<script lang="ts">
import {onDestroy, onMount} from 'svelte';
import type {MndwSelectChangeDetail, MndwSwitchChangeDetail} from '@mndw/ui';
import PaletteManager from './palette-manager/PaletteManager.svelte';
import ConfirmActionModal from '../opkg/ConfirmActionModal.svelte';
import {openHostModal} from '../../services/overlay/host-overlay.js';
import {toast} from '../../services/toast/toast.svelte.js';
import {appState} from '../../state/app.svelte.js';
import {getHostServices} from '../../host-services-context.js';
import {
  type ControllerTestResult,
  type PersistentRciCapability,
  PersistentRciSessionError,
} from '../../services/persistent-rci-session.service.js';

interface CapabilityState {
  visible: boolean;
  available: boolean;
}

interface Props {
  onCapabilityStateChange: (state: CapabilityState) => void;
}

interface ConfirmationProps {
  message: string;
  confirmLabel: string;
  close: (confirmed: boolean) => void;
}

const TELEMETRY_SAVE_TOAST_KEY = 'settings.telemetry.save';
const TOKENLESS_TOGGLE_TOAST_KEY = 'settings.router-access.toggle';
const CONTROLLER_TEST_TOAST_KEY = 'settings.controller.test';
const CONTROLLER_SAVE_TOAST_KEY = 'settings.controller.save';
const CONTROLLER_CLEAR_TOAST_KEY = 'settings.controller.clear';

let {onCapabilityStateChange}: Props = $props();
const services = getHostServices();
const locale = services.locale;
const persistentRci = services.persistentRci;
const hostT = locale.hostT;

let persistentCapability = $state<PersistentRciCapability | null>(null);
let persistentAuth = $derived.by(() =>
  persistentCapability?.controller.auth ?? 'unknown'
);

let controllerSessionConfigured = $derived.by(() => {
  const support = persistentCapability?.controller.support;

  return support === 'supported' || support === 'invalid';
});

let controllerTokenPlaceholder = $derived.by(() => {
  return controllerSessionConfigured
    ? hostT('settings.controller-token-set-placeholder')
    : '';
});

let persistentEnabled = $state(false);
let persistentLoading = $state(true);
let persistentActionLoading = $state(false);
let controllerToken = $state('');
let controllerResult = $state<ControllerTestResult | null>(null);
let capabilityPollController: AbortController | null = null;
let destroyed = false;
let telemetryEnabled = $state(false);
let telemetryLoading = $state(true);
let telemetryError = $state('');
let unsubscribeTelemetryGathering: (() => void) | undefined;
// Mirrors daemon `SessionPresent()` for telemetry availability.
let telemetrySessionPresent = $derived.by(() => {
  const support = persistentCapability?.controller.support;

  return persistentCapability?.controller.enabled === true
    && (support === 'supported' || support === 'invalid');
});
let extenders = $derived(
  persistentCapability?.controller.support === 'supported'
    ? persistentCapability.extenders
    : [],
);
let extendersWithoutAccess = $derived(
  extenders.filter((extender) => {
    return !extender.eligible || extender.state !== 'live';
  }).length,
);

$effect(() => {
  onCapabilityStateChange({
    visible: persistentAuth !== 'unknown',
    available: persistentCapability?.controller.support === 'supported',
  });
});

onMount(() => {
  subscribeToTelemetryGathering();
  void refreshPersistentCapability();
  void refreshTelemetry();
});

onDestroy(() => {
  destroyed = true;
  controllerToken = '';

  capabilityPollController?.abort();

  capabilityPollController = null;
  unsubscribeTelemetryGathering?.();
  unsubscribeTelemetryGathering = undefined;
});

async function refreshPersistentCapability(): Promise<void> {
  persistentLoading = true;

  try {
    const capability = await persistentRci.getCapability();

    if (destroyed) {
      return;
    }

    persistentCapability = capability;
    persistentEnabled = persistentCapability.controller.enabled
      || persistentCapability.controller.support === 'needs-token';

    startCapabilityPolling();
  } catch {
    if (destroyed) {
      return;
    }
    persistentCapability = null;
    persistentEnabled = false;
  } finally {
    if (!destroyed) {
      persistentLoading = false;
    }
  }
}

async function refreshTelemetry(): Promise<void> {
  telemetryLoading = true;
  telemetryError = '';
  try {
    const result = await services.mgmtClient.getTelemetry();

    if (destroyed) {
      return;
    }

    telemetryEnabled = result.enabled;
  } catch {
    if (destroyed) {
      return;
    }
    telemetryError = hostT('settings.telemetry-error');
  } finally {
    if (!destroyed) {
      telemetryLoading = false;
    }
  }
}

function subscribeToTelemetryGathering(): void {
  if (unsubscribeTelemetryGathering !== undefined) {
    return;
  }

  unsubscribeTelemetryGathering = services.telemetryGathering.subscribe(() => {
    const gathering = services.telemetryGathering.get();

    if (gathering !== null) {
      telemetryEnabled = gathering.enabled;
    }
  });
}

function setTelemetryEnabled(
  event: CustomEvent<{checked?: boolean; value?: boolean}>,
): void {
  const next = event.detail.checked ?? event.detail.value ?? false;
  const previous = telemetryEnabled;
  telemetryEnabled = next;
  telemetryError = '';
  telemetryLoading = true;
  void services.mgmtClient.setTelemetry(next).then(() => {
    if (destroyed) {
      return;
    }

    services.telemetryGathering.report(next);
    toast.dismissKey(TELEMETRY_SAVE_TOAST_KEY);
  }).catch(() => {
    if (destroyed) {
      return;
    }

    telemetryEnabled = previous;
    toast.error(hostT('settings.telemetry-error'), {
      key: TELEMETRY_SAVE_TOAST_KEY,
    });
  }).finally(() => {
    if (!destroyed) {
      telemetryLoading = false;
    }
  });
}

function setPersistentEnabled(
  event: CustomEvent<{checked?: boolean; value?: boolean}>,
): void {
  persistentEnabled = event.detail.checked ?? event.detail.value ?? false;
  controllerResult = null;

  if (!persistentEnabled) {
    controllerToken = '';
    capabilityPollController?.abort();
    capabilityPollController = null;
  }
}

async function setTokenlessEnabled(
  event: CustomEvent<{checked?: boolean; value?: boolean}>,
): Promise<void> {
  const next = event.detail.checked ?? event.detail.value ?? false;
  const previous = persistentCapability?.controller.enabled ?? false;

  persistentActionLoading = true;

  if (persistentCapability) {
    persistentCapability = {
      ...persistentCapability,
      controller: {...persistentCapability.controller, enabled: next},
    };
  }

  try {
    await persistentRci.setEnabled(next);
    if (destroyed) {
      return;
    }
    await refreshPersistentCapability();
    if (destroyed) {
      return;
    }
    toast.dismissKey(TOKENLESS_TOGGLE_TOAST_KEY);
  } catch (error) {
    if (destroyed) {
      return;
    }
    if (persistentCapability) {
      persistentCapability = {
        ...persistentCapability,
        controller: {...persistentCapability.controller, enabled: previous},
      };
    }

    await refreshPersistentCapability();
    if (destroyed) {
      return;
    }
    toast.error(persistentErrorMessage(error), {
      key: TOKENLESS_TOGGLE_TOAST_KEY,
    });
  } finally {
    if (!destroyed) {
      persistentActionLoading = false;
    }
  }
}

function setControllerToken(event: CustomEvent<{value: string}>): void {
  controllerToken = event.detail.value;
}

function persistentErrorMessage(error: unknown): string {
  if (error instanceof PersistentRciSessionError) {
    if (error.code === 'RCI_TOKEN_INVALID') {
      return hostT('settings.controller-token-rejected');
    }
    if (error.code === 'RCI_FIRMWARE_UNSUPPORTED') {
      return hostT('settings.firmware-unsupported');
    }
    if (error.code === 'RCI_DEVICE_UNREACHABLE') {
      return hostT('settings.device-unreachable');
    }
  }

  return hostT('settings.persistent-request-failed');
}

async function testController(): Promise<void> {
  persistentActionLoading = true;
  controllerResult = null;

  try {
    const result = await persistentRci.testController(controllerToken);

    if (destroyed) {
      return;
    }

    showControllerResult(result, CONTROLLER_TEST_TOAST_KEY);
  } catch (error) {
    if (!destroyed) {
      toast.error(persistentErrorMessage(error), {
        key: CONTROLLER_TEST_TOAST_KEY,
      });
    }
  } finally {
    if (!destroyed) {
      persistentActionLoading = false;
    }
  }
}

async function saveController(): Promise<void> {
  persistentActionLoading = true;
  controllerResult = null;

  try {
    const result = await persistentRci.saveController(controllerToken);

    if (destroyed) {
      return;
    }

    showControllerResult(result, CONTROLLER_SAVE_TOAST_KEY);
    controllerToken = '';

    await refreshPersistentCapability();
  } catch (error) {
    if (!destroyed) {
      toast.error(persistentErrorMessage(error), {
        key: CONTROLLER_SAVE_TOAST_KEY,
      });
    }
  } finally {
    if (!destroyed) {
      controllerToken = '';
      persistentActionLoading = false;
    }
  }
}

async function clearController(): Promise<void> {
  const session = openHostModal<boolean, ConfirmationProps>(
    services.hostOverlay,
    ConfirmActionModal,
    {
      title: hostT('settings.clear-controller-session-title'),
      props: {
        message: hostT('settings.clear-controller-session-confirm'),
        confirmLabel: hostT('settings.clear-controller-session'),
      },
    },
  );
  const event = await session.closed;

  if (destroyed || event.result !== true) {
    return;
  }

  persistentActionLoading = true;

  try {
    await persistentRci.clearController();

    if (destroyed) {
      return;
    }

    persistentEnabled = false;
    controllerToken = '';
    controllerResult = null;

    await refreshPersistentCapability();
    if (destroyed) {
      return;
    }
    toast.dismissKey(CONTROLLER_CLEAR_TOAST_KEY);
  } catch (error) {
    if (!destroyed) {
      toast.error(persistentErrorMessage(error), {
        key: CONTROLLER_CLEAR_TOAST_KEY,
      });
    }
  } finally {
    if (!destroyed) {
      persistentActionLoading = false;
    }
  }
}

function showControllerResult(
  result: ControllerTestResult,
  toastKey: string,
): void {
  controllerResult = result;

  if (result.result === 'valid') {
    toast.success(hostT('settings.controller-token-valid'), {key: toastKey});
  } else if (result.result === 'unreachable') {
    toast.error(hostT('settings.device-unreachable'), {key: toastKey});
  } else {
    toast.dismissKey(toastKey);
  }
}

function handleLocaleChange(event: CustomEvent<MndwSelectChangeDetail>): void {
  if (appState.localeSwitchPending) {
    return;
  }

  void locale.setLocale(event.detail.value).catch(() => {});
}

function focusBackgroundRouterAccess(event: MouseEvent): void {
  event.preventDefault();

  const section = document.getElementById('mndw-background-router-access');

  if (!section) {
    return;
  }

  section.scrollIntoView({behavior: 'smooth', block: 'start'});
  section.focus({preventScroll: true});
}

function startCapabilityPolling(): void {
  capabilityPollController?.abort();

  if (!persistentCapability || !capabilityNeedsPolling(persistentCapability)) {
    capabilityPollController = null;
    return;
  }

  const controller = new AbortController();
  capabilityPollController = controller;

  void pollCapability(controller.signal);
}

function capabilityNeedsPolling(capability: PersistentRciCapability): boolean {
  return capability.controller.support === 'invalid'
    || capability.extenders.some((extender) => {
      return extender.state === 'establishing' || extender.state === 'dead';
    });
}

async function pollCapability(signal: AbortSignal): Promise<void> {
  let deadSince: number | null = null;

  while (
    !signal.aborted && persistentCapability
    && capabilityNeedsPolling(persistentCapability)
  ) {
    // @dprint-ignore
    if (persistentCapability.extenders.some((extender) => extender.state === 'establishing')) {
      deadSince = null;
    } else if (deadSince === null) {
      deadSince = Date.now();
    } else if (Date.now() - deadSince >= 60_000) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, 2_000);

      signal.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        {once: true},
      );
    });

    if (signal.aborted) {
      return;
    }

    try {
      persistentCapability = await persistentRci.getCapability();
    } catch {
      // Keep polling through transient capability fetch failures.
    }
  }
}
</script>

<div
  class="mndw-general-settings"
  data-locale={appState.locale}
>
  <section>
    <h3>{hostT('settings.appearance')}</h3>
    <mndw-field label={hostT('settings.dark-theme')}>
      <mndw-switch
        id="mndw-theme-switch"
        checked={appState.theme === 'dark'}
        onmndwchange={services.theme.toggleTheme}
      >
      </mndw-switch>
    </mndw-field>
    <mndw-field label={hostT('settings.language.label')}>
      <mndw-select
        value={appState.locale}
        aria-busy={String(appState.localeSwitchPending)}
        onmndwchange={handleLocaleChange}
      >
        <mndw-option value="en">
          {hostT('settings.language.english')}
        </mndw-option>
        <mndw-option value="ru">
          {hostT('settings.language.russian')}
        </mndw-option>
        {#if locale.getAvailableLocales().includes('en-XA')}
          <mndw-option value="en-XA">Pseudo (en-XA)</mndw-option>
        {/if}
      </mndw-select>
      {#if appState.localeSwitchPending}
        <span role="status">{hostT('settings.language.pending')}</span>
      {/if}
    </mndw-field>
  </section>

  <PaletteManager />

  <section>
    <h3>{hostT('settings.device')}</h3>
    {#if appState.deviceInfo}
      <ul>
        <li>
          <strong>{hostT('settings.name')}</strong>
          {appState.deviceInfo.deviceName}
        </li>
        <li>
          <strong>{hostT('settings.vendor')}</strong>
          {appState.deviceInfo.vendor}
        </li>
        <li>
          <strong>{hostT('settings.firmware')}</strong>
          {appState.deviceInfo.firmwareVersion}
        </li>
      </ul>
    {:else}
      <p>{hostT('settings.device-unavailable')}</p>
    {/if}
  </section>

  <section
    id="mndw-background-router-access"
    aria-label={hostT('settings.persistent-rci-title')}
    tabindex="-1"
  >
    <h3>{hostT('settings.persistent-rci-title')}</h3>
    <p>{hostT('settings.persistent-rci-description')}</p>
    {#if persistentLoading}
      <p role="status">{hostT('settings.persistent-loading')}</p>
    {:else}
      {#if persistentAuth === 'unknown'}
        <div
          class="mndw-alert mndw-alert--danger"
          role="alert"
        >
          <p>{hostT('settings.persistent-state-unavailable')}</p>
          <mndw-button
            variant="secondary"
            onclick={() => void refreshPersistentCapability()}
          >
            {hostT('common.retry')}
          </mndw-button>
        </div>
      {:else if persistentAuth === 'none'}
        <mndw-field label={hostT('settings.persistent-tokenless-toggle')}>
          <mndw-switch
            id="mndw-persistent-rci-enabled"
            checked={persistentCapability?.controller.enabled ?? false}
            disabled={persistentActionLoading}
            onmndwchange={(event: CustomEvent<MndwSwitchChangeDetail>) =>
            void setTokenlessEnabled(event)}
          >
          </mndw-switch>
        </mndw-field>
        <p>{hostT('settings.persistent-tokenless-description')}</p>
      {:else}
        <mndw-field label={hostT('settings.configure-persistent')}>
          <mndw-switch
            id="mndw-persistent-rci-enabled"
            checked={persistentEnabled}
            disabled={persistentLoading || persistentActionLoading}
            onmndwchange={setPersistentEnabled}
          >
          </mndw-switch>
        </mndw-field>
        {#if persistentCapability?.store.state === 'disabled'}
          <p role="status">{hostT('settings.persistent-storage-disabled')}</p>
        {:else if persistentCapability?.store.state === 'decrypt-failed'}
          <p role="alert">
            {hostT('settings.persistent-storage-decrypt-failed')}
          </p>
        {/if}
        {#if persistentCapability?.controller.support === 'needs-token'}
          <p role="status">{hostT('settings.persistent-needs-token')}</p>
        {/if}
        {#if persistentEnabled
        || persistentCapability?.controller.support === 'needs-token'}
          <mndw-field label={hostT('settings.controller-token')}>
            <mndw-input
              type="password"
              autocomplete="off"
              aria-describedby="mndw-controller-token-hint"
              placeholder={controllerTokenPlaceholder}
              value={controllerToken}
              disabled={persistentActionLoading}
              onmndwinput={setControllerToken}
            >
            </mndw-input>
          </mndw-field>
          <p
            id="mndw-controller-token-hint"
            class="persistent-rci-hint"
          >
            {hostT('settings.controller-token-hint')}
          </p>
          <div class="persistent-rci-actions">
            <mndw-button
              variant="secondary"
              disabled={persistentActionLoading || controllerToken === ''}
              onclick={() => void testController()}
            >
              {hostT('settings.test')}
            </mndw-button>
            <mndw-button
              variant="primary"
              disabled={persistentActionLoading || controllerToken === ''}
              onclick={() => void saveController()}
            >
              {hostT('settings.save')}
            </mndw-button>
            {#if controllerSessionConfigured}
              <mndw-button
                variant="danger"
                disabled={persistentActionLoading}
                onclick={() => void clearController()}
              >
                {hostT('settings.clear-controller-session')}
              </mndw-button>
            {/if}
          </div>
          {#if controllerResult}
            {#if controllerResult.result === 'unsupported-firmware'}
              <p role="status">
                {hostT('settings.update-firmware-persistent')}
              </p>
            {:else if controllerResult.result === 'invalid-token'}
              <p
                class="unsupported-banner"
                role="alert"
              >
                {hostT('settings.controller-token-rejected')}
              </p>
            {/if}
          {/if}
        {/if}
      {/if}
      {#if persistentCapability?.controller.support === 'supported'}
        <details class="persistent-rci-extenders">
          <summary>
            {#if extendersWithoutAccess > 0}
              {
                hostT('settings.persistent-extenders-summary-problems', {
                  count: extenders.length,
                  problems: extendersWithoutAccess,
                })
              }
            {:else}
              {
                hostT('settings.persistent-extenders-summary', {
                  count: extenders.length,
                })
              }
            {/if}
            {#if persistentCapability.stale}
              <span> — {hostT('settings.persistent-enumeration-stale')}</span>
            {/if}
          </summary>
          {#if extenders.length > 0}
            <ul>
              {#each extenders as extender (extender.identity)}
                <li>
                  {extender.name || extender.identity}:
                  {#if !extender.eligible}
                    {hostT(`settings.extender-reason-${extender.reason}`)}
                  {:else}
                    {
                      hostT(
                        `settings.extender-state-${
                          extender.state ?? 'establishing'
                        }`,
                      )
                    }
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </details>
      {/if}
    {/if}
  </section>

  <section
    id="mndw-telemetry"
    aria-label={hostT('settings.telemetry-label')}
  >
    <h3>{hostT('settings.telemetry-label')}</h3>
    <mndw-field label={hostT('settings.telemetry-toggle')}>
      <mndw-switch
        id="mndw-telemetry-enabled"
        checked={telemetryEnabled}
        disabled={telemetryLoading || !telemetrySessionPresent}
        onmndwchange={setTelemetryEnabled}
      >
      </mndw-switch>
    </mndw-field>
    <p>{hostT('settings.telemetry-description')}</p>
    {#if !telemetrySessionPresent}
      <p>
        {hostT('settings.telemetry-session-note')}
        <a
          href="#mndw-background-router-access"
          onclick={focusBackgroundRouterAccess}
          class="mndw-link"
        >
          {hostT('settings.telemetry-session-link')}
        </a>
      </p>
    {/if}
    <p>{hostT('settings.telemetry-wear-note')}</p>
    {#if telemetryError}
      <div
        class="mndw-alert mndw-alert--danger"
        role="alert"
      >
        <p>{telemetryError}</p>
        <mndw-button
          variant="secondary"
          onclick={() => void refreshTelemetry()}
        >
          {hostT('common.retry')}
        </mndw-button>
      </div>
    {/if}
  </section>
</div>

<style>
.mndw-general-settings mndw-field {
  margin: 0.75rem 0;
}

.persistent-rci-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.75rem 0;
}

.persistent-rci-hint {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.persistent-rci-extenders {
  margin-top: 1.5rem;
  padding-left: 1rem;
  border-left: 2px solid var(--mndw-color-border, currentColor);
}

.persistent-rci-extenders summary {
  cursor: pointer;
}

.unsupported-banner {
  padding: 0.75rem;
  color: var(--mndw-color-on-danger, #fff);
  background: var(--mndw-color-danger, #a00);
}
</style>
