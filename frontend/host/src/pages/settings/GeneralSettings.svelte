<script lang="ts">
import {onDestroy, onMount} from 'svelte';
import type {MndwSelectChangeDetail, MndwSwitchChangeDetail} from '@mndw/ui';
import PaletteManager from './palette-manager/PaletteManager.svelte';
import {toggleTheme} from '../../services/theme.service.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import {appState} from '../../state/app.svelte.js';
import {getHostServices} from '../../host-services-context.js';
import {
  type ControllerTestResult,
  type PersistentRciCapability,
  PersistentRciSessionError,
} from '../../services/persistent-rci-session.service.js';

interface PermissionState {
  visible: boolean;
  available: boolean;
}

interface Props {
  onPermissionStateChange: (state: PermissionState) => void;
}

let {onPermissionStateChange}: Props = $props();
const services = getHostServices();
const locale = services.locale;
const persistentRci = services.persistentRci;

let persistentCapability = $state<PersistentRciCapability | null>(null);
let persistentAuth = $derived.by(() =>
  persistentCapability?.controller.auth ?? 'unknown'
);

let controllerSessionConfigured = $derived.by(() => {
  const support = persistentCapability?.controller.support;

  return support === 'supported' || support === 'invalid';
});

let controllerTokenPlaceholder = $derived.by(() => {
  return controllerSessionConfigured ? '<TOKEN SET>' : '';
});

let persistentEnabled = $state(false);
let persistentLoading = $state(true);
let persistentActionLoading = $state(false);
let persistentError = $state('');
let controllerToken = $state('');
let controllerResult = $state<ControllerTestResult | null>(null);
let capabilityPollController: AbortController | null = null;
let telemetryEnabled = $state(false);
let telemetryLoading = $state(true);
let telemetryError = $state('');
// Mirrors daemon `SessionPresent()` for telemetry availability.
let telemetrySessionPresent = $derived.by(() => {
  const support = persistentCapability?.controller.support;

  return persistentCapability?.controller.enabled === true
    && (support === 'supported' || support === 'invalid');
});

$effect(() => {
  onPermissionStateChange({
    visible: persistentAuth !== 'unknown',
    available: persistentCapability?.controller.support === 'supported',
  });
});

onMount(() => {
  void refreshPersistentCapability();
  void refreshTelemetry();
});

onDestroy(() => {
  controllerToken = '';

  capabilityPollController?.abort();

  capabilityPollController = null;
});

async function refreshPersistentCapability(): Promise<void> {
  persistentLoading = true;
  persistentError = '';

  try {
    persistentCapability = await persistentRci.getCapability();
    persistentEnabled = persistentCapability.controller.enabled
      || persistentCapability.controller.support === 'needs-token';

    startCapabilityPolling();
  } catch {
    persistentCapability = null;
    persistentEnabled = false;
  } finally {
    persistentLoading = false;
  }
}

async function refreshTelemetry(): Promise<void> {
  telemetryLoading = true;
  telemetryError = '';
  try {
    telemetryEnabled = (await services.mgmtClient.getTelemetry()).enabled;
  } catch {
    telemetryError = hostT('settings.telemetry-error');
  } finally {
    telemetryLoading = false;
  }
}

function setTelemetryEnabled(
  event: CustomEvent<{checked?: boolean; value?: boolean}>,
): void {
  const next = event.detail.checked ?? event.detail.value ?? false;
  const previous = telemetryEnabled;
  telemetryEnabled = next;
  telemetryError = '';
  telemetryLoading = true;
  void services.mgmtClient.setTelemetry(next).catch(() => {
    telemetryEnabled = previous;
    telemetryError = hostT('settings.telemetry-error');
  }).finally(() => {
    telemetryLoading = false;
  });
}

function setPersistentEnabled(
  event: CustomEvent<{checked?: boolean; value?: boolean}>,
): void {
  persistentEnabled = event.detail.checked ?? event.detail.value ?? false;
  controllerResult = null;
  persistentError = '';

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

  persistentError = '';

  try {
    await persistentRci.setEnabled(next);
    await refreshPersistentCapability();
  } catch (error) {
    if (persistentCapability) {
      persistentCapability = {
        ...persistentCapability,
        controller: {...persistentCapability.controller, enabled: previous},
      };
    }

    await refreshPersistentCapability();
    persistentError = persistentErrorMessage(error);
  } finally {
    persistentActionLoading = false;
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
  persistentError = '';
  controllerResult = null;

  try {
    controllerResult = await persistentRci.testController(controllerToken);
  } catch (error) {
    persistentError = persistentErrorMessage(error);
  } finally {
    persistentActionLoading = false;
  }
}

async function saveController(): Promise<void> {
  persistentActionLoading = true;
  persistentError = '';
  controllerResult = null;

  try {
    // @dprint-ignore
    controllerResult = await persistentRci.saveController(controllerToken);
    controllerToken = '';

    await refreshPersistentCapability();
  } catch (error) {
    persistentError = persistentErrorMessage(error);
  } finally {
    controllerToken = '';
    persistentActionLoading = false;
  }
}

async function clearController(): Promise<void> {
  persistentActionLoading = true;
  persistentError = '';

  try {
    await persistentRci.clearController();

    persistentEnabled = false;
    controllerToken = '';
    controllerResult = null;

    await refreshPersistentCapability();
  } catch (error) {
    persistentError = persistentErrorMessage(error);
  } finally {
    persistentActionLoading = false;
  }
}

function handleLocaleChange(event: CustomEvent<MndwSelectChangeDetail>): void {
  if (appState.localeSwitchPending) {
    return;
  }

  void locale.setLocale(event.detail.value).catch(() => {});
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
        onmndwchange={toggleTheme}
      >
      </mndw-switch>
    </mndw-field>
  </section>

  <PaletteManager />

  <section>
    <h3>{hostT('settings.device')}</h3>
    <mndw-field label={hostT('settings.language.label')}>
      <mndw-select
        value={appState.locale}
        disabled={appState.localeSwitchPending}
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

  {#if !persistentLoading}
    <section aria-label={hostT('settings.persistent-rci-title')}>
      <h3>{hostT('settings.persistent-rci-title')}</h3>
      {#if persistentAuth === 'unknown'}
        <p role="alert">{hostT('settings.persistent-state-unavailable')}</p>
        {#if persistentError}
          <p role="alert">{persistentError}</p>
        {/if}
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
        {#if persistentError}
          <p role="alert">{persistentError}</p>
        {/if}
        {#if persistentCapability?.controller.support === 'supported'}
          <div class="persistent-rci-extenders">
            <h4>{hostT('settings.persistent-extenders-title')}</h4>
            {#if persistentCapability.stale}
              <p role="status">
                {hostT('settings.persistent-enumeration-stale')}
              </p>
            {/if}
            {#if persistentCapability.extenders.length > 0}
              <ul>
                {#each persistentCapability.extenders as
                  extender
                  (extender.identity)
                }
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
          </div>
        {/if}
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
        {#if persistentError}
          <p role="alert">{persistentError}</p>
        {/if}
        {#if persistentCapability?.store.state === 'disabled'}
          <p role="alert">{hostT('settings.persistent-storage-disabled')}</p>
        {:else if persistentCapability?.store.state === 'decrypt-failed'}
          <p role="alert">
            {hostT('settings.persistent-storage-decrypt-failed')}
          </p>
        {/if}
        {#if persistentCapability?.controller.support === 'needs-token'}
          <p role="alert">{hostT('settings.persistent-needs-token')}</p>
        {/if}
        {#if persistentEnabled
        || persistentCapability?.controller.support === 'needs-token'}
          <mndw-field label={hostT('settings.controller-token')}>
            <mndw-input
              type="password"
              autocomplete="off"
              placeholder={controllerTokenPlaceholder}
              value={controllerToken}
              disabled={persistentActionLoading}
              onmndwinput={setControllerToken}
            >
            </mndw-input>
          </mndw-field>
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
              <p
                class="unsupported-banner"
                role="alert"
              >
                {hostT('settings.update-firmware-persistent')}
              </p>
            {:else}
              <p>
                {
                  hostT('settings.controller-result', {
                    result: controllerResult.result,
                  })
                }
              </p>
            {/if}
          {/if}
          {#if persistentCapability?.controller.support === 'supported'}
            <div class="persistent-rci-extenders">
              <h4>{hostT('settings.persistent-extenders-title')}</h4>
              {#if persistentCapability.stale}
                <p role="status">
                  {hostT('settings.persistent-enumeration-stale')}
                </p>
              {/if}
              {#if persistentCapability.extenders.length > 0}
                <ul>
                  {#each persistentCapability.extenders as
                    extender
                    (extender.identity)
                  }
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
            </div>
          {/if}
        {/if}
      {/if}
    </section>
  {/if}

  {#if telemetrySessionPresent}
    <section>
      <h3>{hostT('settings.telemetry-label')}</h3>
      <mndw-field label={hostT('settings.telemetry-toggle')}>
        <mndw-switch
          id="mndw-telemetry-enabled"
          checked={telemetryEnabled}
          disabled={telemetryLoading}
          onmndwchange={setTelemetryEnabled}
        >
        </mndw-switch>
      </mndw-field>
      <p>{hostT('settings.telemetry-description')}</p>
      <p>{hostT('settings.telemetry-session-note')}</p>
      <p>{hostT('settings.telemetry-wear-note')}</p>
      {#if telemetryError}
        <p role="alert">{telemetryError}</p>
      {/if}
    </section>
  {/if}
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

.persistent-rci-extenders {
  margin-top: 1.5rem;
  padding-left: 1rem;
  border-left: 2px solid var(--mndw-color-border, currentColor);
}

.unsupported-banner {
  padding: 0.75rem;
  color: var(--mndw-color-on-danger, #fff);
  background: var(--mndw-color-danger, #a00);
}
</style>
