<script lang="ts">
import PaletteManager from './palette-manager/PaletteManager.svelte';
import type {MndwSelectChangeDetail} from '@mndw/ui';
import {toggleTheme} from '../../services/theme.service.js';
import {getAvailableLocales, setLocale} from '../../services/locale.service.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import {appState} from '../../state/app.svelte.js';
import {onDestroy, onMount} from 'svelte';
import {
  type ControllerTestResult,
  type PersistentRciCapability,
  PersistentRciSessionError,
  type ProvisionReason,
  persistentRciSessionService,
} from '../../services/persistent-rci-session.service.js';

interface PermissionState {
  visible: boolean;
  available: boolean;
}

interface Props {
  onPermissionStateChange: (state: PermissionState) => void;
}

let {onPermissionStateChange}: Props = $props();
let persistentCapability = $state<PersistentRciCapability | null>(null);
let persistentProbeAvailable = $state(false);
let controllerTokenPlaceholder = $derived.by(() => {
  return persistentCapability?.controller.support === 'supported'
      || persistentCapability?.controller.support === 'invalid'
    ? '<TOKEN SET>'
    : '';
});
let persistentEnabled = $state(false);
let persistentLoading = $state(true);
let persistentActionLoading = $state(false);
let persistentError = $state('');
let controllerToken = $state('');
let controllerResult = $state<ControllerTestResult | null>(null);
let meshUsername = $state('');
let meshPassword = $state('');
let provisioningResult = $state('');

$effect(() => {
  onPermissionStateChange({
    visible: persistentProbeAvailable,
    available: persistentCapability?.controller.support === 'supported',
  });
});

onMount(() => {
  void refreshPersistentCapability();
});

onDestroy(() => {
  controllerToken = '';
  meshUsername = '';
  meshPassword = '';
});

async function refreshPersistentCapability(): Promise<void> {
  persistentLoading = true;
  persistentError = '';
  persistentProbeAvailable = false;
  try {
    if (!await persistentRciSessionService.probeControllerTokenAuth()) {
      persistentCapability = null;
      persistentEnabled = false;
      return;
    }

    persistentProbeAvailable = true;
    persistentCapability = await persistentRciSessionService.getCapability();
    persistentEnabled = persistentCapability.controller.support === 'supported'
      || persistentCapability.controller.support === 'invalid';
  } catch {
    persistentError = hostT('settings.persistent-state-unavailable');
  } finally {
    persistentLoading = false;
  }
}

function setPersistentEnabled(
  event: CustomEvent<{checked?: boolean; value?: boolean}>,
): void {
  persistentEnabled = event.detail.checked ?? event.detail.value ?? false;
  controllerResult = null;
  persistentError = '';
  if (!persistentEnabled) {
    controllerToken = '';
    meshUsername = '';
    meshPassword = '';
  }
}

function setControllerToken(event: CustomEvent<{value: string}>): void {
  controllerToken = event.detail.value;
}

function setMeshUsername(event: CustomEvent<{value: string}>): void {
  meshUsername = event.detail.value;
}

function setMeshPassword(event: CustomEvent<{value: string}>): void {
  meshPassword = event.detail.value;
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
    controllerResult = await persistentRciSessionService.testController(
      controllerToken,
    );
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
    controllerResult = await persistentRciSessionService.saveController(
      controllerToken,
    );
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
    await persistentRciSessionService.clearController();
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

async function provisionExtenders(): Promise<void> {
  persistentActionLoading = true;
  persistentError = '';
  provisioningResult = '';
  try {
    const result = await persistentRciSessionService.provisionExtenders({
      username: meshUsername,
      password: meshPassword,
    });
    const failures = result.extenders.filter((extender) =>
      extender.reason !== undefined
    );
    provisioningResult = failures.length > 0
      ? failures.map((extender) =>
        `${extender.identity}: ${provisionReasonMessage(extender.reason)}`
      ).join('; ')
      : hostT('settings.extenders-checked', {count: result.extenders.length});
    meshUsername = '';
    meshPassword = '';
    await refreshPersistentCapability();
  } catch (error) {
    persistentError = persistentErrorMessage(error);
  } finally {
    meshUsername = '';
    meshPassword = '';
    persistentActionLoading = false;
  }
}

function provisionReasonMessage(reason: ProvisionReason | undefined): string {
  if (reason === undefined) {
    return hostT('settings.provisioning-failed');
  }
  switch (reason) {
    case 'secure-endpoint-unavailable':
      return hostT('settings.secure-endpoint-unavailable');
    case 'offline':
      return hostT('settings.extender-offline');
    case 'authentication-failed':
      return hostT('settings.authentication-failed');
    case 'unsupported-firmware':
      return hostT('settings.firmware-unsupported-short');
    case 'unreachable':
      return hostT('settings.extender-unreachable');
  }
}

function handleLocaleChange(event: CustomEvent<MndwSelectChangeDetail>): void {
  if (appState.localeSwitchPending) {
    return;
  }

  void setLocale(event.detail.value).catch(() => {});
}

async function clearExtenders(): Promise<void> {
  persistentActionLoading = true;
  persistentError = '';
  try {
    await persistentRciSessionService.clearExtenders();
    await refreshPersistentCapability();
  } catch (error) {
    persistentError = persistentErrorMessage(error);
  } finally {
    persistentActionLoading = false;
  }
}
</script>

<div
  class="mndw-general-settings"
  data-locale={appState.locale}
>
  <section>
    <h3>{hostT('settings.appearance')}</h3>
    <!-- A switch, not a checkbox: the theme applies at once rather than travelling with a form. -->
    <mndw-field label={hostT('settings.dark-theme')}>
      <mndw-switch
        id="mndw-theme-switch"
        checked={appState.theme === 'dark'}
        onmndwchange={toggleTheme}
      ></mndw-switch>
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
        <mndw-option value="en">{
          hostT('settings.language.english')
        }</mndw-option>
        <mndw-option value="ru">{
          hostT('settings.language.russian')
        }</mndw-option>
        {#if getAvailableLocales().includes('en-XA')}
          <mndw-option value="en-XA">Pseudo (en-XA)</mndw-option>
        {/if}
      </mndw-select>
      {#if appState.localeSwitchPending}
        <span role="status">{hostT('settings.language.pending')}</span>
      {/if}
    </mndw-field>
    {#if appState.hostInfo}
      <ul>
        <li>
          <strong>{hostT('settings.name')}</strong> {
            appState.hostInfo.deviceName
          }
        </li>
        <li>
          <strong>{hostT('settings.vendor')}</strong> {appState.hostInfo.vendor}
        </li>
        <li>
          <strong>{hostT('settings.firmware')}</strong> {
            appState.hostInfo.firmwareVersion
          }
        </li>
      </ul>
    {:else}
      <p>{hostT('settings.device-unavailable')}</p>
    {/if}
  </section>

  {#if persistentProbeAvailable}
    <section aria-label={hostT('settings.persistent-rci-title')}>
      <h3>{hostT('settings.persistent-rci-title')}</h3>
      <p>{hostT('settings.persistent-rci-description')}</p>
      <mndw-field label={hostT('settings.configure-persistent')}>
        <mndw-switch
          id="mndw-persistent-rci-enabled"
          checked={persistentEnabled}
          disabled={persistentLoading || persistentActionLoading}
          onmndwchange={setPersistentEnabled}
        ></mndw-switch>
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
      {#if persistentEnabled}
        <mndw-field label={hostT('settings.controller-token')}>
          <mndw-input
            type="password"
            autocomplete="off"
            placeholder={controllerTokenPlaceholder}
            value={controllerToken}
            disabled={persistentActionLoading}
            onmndwinput={setControllerToken}
          ></mndw-input>
        </mndw-field>
        <div class="persistent-rci-actions">
          <mndw-button
            variant="secondary"
            disabled={persistentActionLoading || controllerToken === ''}
            onclick={() => void testController()}
          >{hostT('settings.test')}</mndw-button>
          <mndw-button
            variant="primary"
            disabled={persistentActionLoading || controllerToken === ''}
            onclick={() => void saveController()}
          >{hostT('settings.save')}</mndw-button>
          {#if persistentCapability?.controller.support === 'supported'
          || persistentCapability?.controller.support === 'invalid'}
            <mndw-button
              variant="danger"
              disabled={persistentActionLoading}
              onclick={() => void clearController()}
            >{hostT('settings.clear-controller-session')}</mndw-button>
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
            <p>{hostT('settings.mesh-credentials-description')}</p>
            <mndw-field label={hostT('settings.mesh-username')}>
              <mndw-input
                autocomplete="username"
                value={meshUsername}
                disabled={persistentActionLoading}
                onmndwinput={setMeshUsername}
              ></mndw-input>
            </mndw-field>
            <mndw-field label={hostT('settings.mesh-password')}>
              <mndw-input
                type="password"
                autocomplete="current-password"
                value={meshPassword}
                disabled={persistentActionLoading}
                onmndwinput={setMeshPassword}
              ></mndw-input>
            </mndw-field>
            <div class="persistent-rci-actions">
              <mndw-button
                variant="primary"
                disabled={persistentActionLoading || meshUsername === ''
                || meshPassword === ''}
                onclick={() => void provisionExtenders()}
              >{hostT('settings.provision-extenders')}</mndw-button>
              <mndw-button
                variant="danger"
                disabled={persistentActionLoading}
                onclick={() => void clearExtenders()}
              >{hostT('settings.clear-extender-sessions')}</mndw-button>
            </div>
            {#if provisioningResult}<p>{provisioningResult}</p>{/if}
            {#if persistentCapability.extenders.length > 0}
              <ul>
                {#each persistentCapability.extenders as
                  extender
                  (extender.identity)
                }
                  <li>
                    {extender.name || extender.identity}: {extender.support}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
.mndw-general-settings mndw-field {
  display: block;
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
