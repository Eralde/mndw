<script lang="ts">
import PluginManager from './plugin-manager/PluginManager.svelte';
import PaletteManager from './palette-manager/PaletteManager.svelte';
import {toggleTheme} from '../../services/theme.service.js';
import {appState} from '../../state/app.svelte.js';
import {onDestroy, onMount} from 'svelte';
import {extenderAccessService} from '../../services/extender-access.service.js';
import {
  type ControllerTestResult,
  type PersistentRciCapability,
  PersistentRciSessionError,
  persistentRciSessionService,
} from '../../services/persistent-rci-session.service.js';

let extenderAccessEnabled = $state(false);
let extenderAccessLoading = $state(true);
let extenderAccessError = $state('');
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

onMount(() => {
  void extenderAccessService.getExtenderAccess().then((state) => {
    extenderAccessEnabled = state.enabled;
  }).catch(() => {
    extenderAccessError = 'Extender access state unavailable';
  }).finally(() => {
    extenderAccessLoading = false;
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

async function setExtenderAccess(
  event: CustomEvent<{checked?: boolean; value?: boolean}>,
): Promise<void> {
  const enabled = event.detail.checked ?? event.detail.value ?? false;
  if (
    enabled
    && !window.confirm('Allow mwsd to access configured extender credentials?')
  ) {
    return;
  }
  extenderAccessLoading = true;
  extenderAccessError = '';
  try {
    if (!enabled) {
      await extenderAccessService.postForget();
    }
    const state = await extenderAccessService.setExtenderAccess(enabled);
    extenderAccessEnabled = state.enabled;
  } catch {
    extenderAccessError = 'Could not update extender access';
  } finally {
    extenderAccessLoading = false;
  }
}

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
    persistentError = 'Persistent rci/ session state unavailable';
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
      return 'Controller token rejected';
    }
    if (error.code === 'RCI_FIRMWARE_UNSUPPORTED') {
      return 'Device firmware does not support persistent rci/ sessions';
    }
    if (error.code === 'RCI_DEVICE_UNREACHABLE') {
      return 'Device unreachable';
    }
  }
  return 'Persistent rci/ session request failed';
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
    provisioningResult = `${result.extenders.length} extender session${
      result.extenders.length === 1 ? '' : 's'
    } checked`;
    meshUsername = '';
    meshPassword = '';
    await refreshPersistentCapability();
  } catch (error) {
    persistentError = persistentErrorMessage(error);
  } finally {
    meshPassword = '';
    persistentActionLoading = false;
  }
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

<div class="mndw-settings">
  <h2>Settings</h2>

  <section>
    <h3>Appearance</h3>
    <!-- A switch, not a checkbox: the theme applies at once rather than travelling with a form. -->
    <mndw-field label="Dark theme">
      <mndw-switch
        id="mndw-theme-switch"
        checked={appState.theme === 'dark'}
        onmndwchange={toggleTheme}
      ></mndw-switch>
    </mndw-field>
  </section>

  <PaletteManager />

  <section>
    <h3>Device</h3>
    {#if appState.hostInfo}
      <ul>
        <li><strong>Name:</strong> {appState.hostInfo.deviceName}</li>
        <li><strong>Vendor:</strong> {appState.hostInfo.vendor}</li>
        <li><strong>Firmware:</strong> {appState.hostInfo.firmwareVersion}</li>
      </ul>
    {:else}
      <p>Device info unavailable.</p>
    {/if}
  </section>

  {#if persistentProbeAvailable}
    <section aria-label="Persistent rci session">
      <h3>Persistent rci/ session</h3>
      <p>
        Keep rci/ access in mndwd for permitted plugins. Tokens never leave
        mndwd.
      </p>
      <mndw-field label="Configure persistent controller session">
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
        <p role="alert">Persistent session storage is disabled.</p>
      {:else if persistentCapability?.store.state === 'decrypt-failed'}
        <p role="alert">Persistent session storage could not be decrypted.</p>
      {/if}
      {#if persistentEnabled}
        <mndw-field label="Controller token">
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
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <mndw-button
            variant="secondary"
            disabled={persistentActionLoading || controllerToken === ''}
            onclick={() => void testController()}
          >Test</mndw-button>
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <mndw-button
            variant="primary"
            disabled={persistentActionLoading || controllerToken === ''}
            onclick={() => void saveController()}
          >Save</mndw-button>
          {#if persistentCapability?.controller.support === 'supported'
          || persistentCapability?.controller.support === 'invalid'}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <mndw-button
              variant="danger"
              disabled={persistentActionLoading}
              onclick={() => void clearController()}
            >Clear controller session</mndw-button>
          {/if}
        </div>
        {#if controllerResult}
          {#if controllerResult.result === 'unsupported-firmware'}
            <p
              class="unsupported-banner"
              role="alert"
            >
              Update device firmware to enable persistent rci/ sessions.
            </p>
          {:else}
            <p>Controller: {controllerResult.result}</p>
          {/if}
        {/if}
        {#if persistentCapability?.controller.support === 'supported'}
          <div class="persistent-rci-extenders">
            <h4>Persistent extenders session</h4>
            <p>
              Mesh credentials are used once for provisioning and then cleared.
            </p>
            <mndw-field label="Mesh username">
              <mndw-input
                autocomplete="username"
                value={meshUsername}
                disabled={persistentActionLoading}
                onmndwinput={setMeshUsername}
              ></mndw-input>
            </mndw-field>
            <mndw-field label="Mesh password">
              <mndw-input
                type="password"
                autocomplete="current-password"
                value={meshPassword}
                disabled={persistentActionLoading}
                onmndwinput={setMeshPassword}
              ></mndw-input>
            </mndw-field>
            <div class="persistent-rci-actions">
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <mndw-button
                variant="primary"
                disabled={persistentActionLoading || meshUsername === ''
                || meshPassword === ''}
                onclick={() => void provisionExtenders()}
              >Provision extenders</mndw-button>
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <mndw-button
                variant="danger"
                disabled={persistentActionLoading}
                onclick={() => void clearExtenders()}
              >Clear extender sessions</mndw-button>
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

  {#if persistentEnabled}
    <section aria-label="Extender access">
      <mndw-field label="Allow mwsd to access extender telemetry">
        <mndw-switch
          id="mndw-extender-access"
          checked={extenderAccessEnabled}
          disabled={extenderAccessLoading}
          onmndwchange={setExtenderAccess}
        ></mndw-switch>
      </mndw-field>
      {#if extenderAccessError}
        <p role="alert">{extenderAccessError}</p>
      {/if}
    </section>
  {/if}

  <section>
    <PluginManager />
  </section>
</div>

<style>
.mndw-settings mndw-field {
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
