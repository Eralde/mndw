<script lang="ts">
import {tick} from 'svelte';
import type {Snippet} from 'svelte';
import Header from './Header.svelte';
import Sidebar from './Sidebar.svelte';
import {initAuthenticated} from '../services/init-auth.js';
import {hostT} from '../services/host-i18n.svelte.js';
import {getHostServices} from '../host-services-context.js';
import {appState, getAuthRunGeneration, resetToLogin} from '../state/app.svelte.js';

let {children}: {children: Snippet} = $props();

// Context functions may only run during component init, so capture here.
const services = getHostServices();

let alertElement: HTMLDivElement | undefined = $state();

/** True when focus is inside the alert, including inside the mndw-button shadow tree. */
function focusIsInsideAlert(): boolean {
  const active = document.activeElement;

  if (active === null) {
    return false;
  }

  const root = active.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : active;

  return alertElement?.contains(host) ?? false;
}

async function retryPluginLoad(): Promise<void> {
  if (appState.authInitInFlight) {
    return;
  }

  // Captured before the call: the retry disables the button while in flight,
  // which would blur it before the remount check runs.
  const hadFocus = focusIsInsideAlert();
  let generation: number | undefined;

  try {
    generation = await initAuthenticated(services, {preservePluginLoadError: true});
  } catch {
    resetToLogin();

    return;
  }

  // A retry superseded by logout or a newer init run must not touch the shell.
  if (generation === undefined || generation !== getAuthRunGeneration()) {
    return;
  }

  if (appState.ready && appState.pluginLoadError === null) {
    appState.pluginLoadRevision += 1;
  } else if (appState.pluginLoadError !== null) {
    // The alert node stays mounted on a repeated failure; keying it on the
    // failure sequence re-mounts it so the new failure is announced again.
    appState.pluginLoadFailureSeq += 1;

    // The remount destroyed the focused Retry button; restore focus to the new one.
    if (hadFocus) {
      await tick();
      const retryButton = alertElement?.querySelector<HTMLElement>('mndw-button');
      retryButton?.shadowRoot?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }
}
</script>

<div class="mndw-app-shell">
  <Header />
  {#if appState.authenticated && appState.pluginLoadError === 'list'}
    {#key appState.pluginLoadFailureSeq}
      <div
        bind:this={alertElement}
        class="mndw-alert mndw-alert--danger mndw-plugin-load-alert"
        role="alert"
      >
        <span>{hostT('app.plugin-load-error')}</span>
        <mndw-button
          variant="secondary"
          disabled={appState.authInitInFlight}
          aria-busy={appState.authInitInFlight}
          onclick={retryPluginLoad}
        >
          {hostT('common.retry')}
        </mndw-button>
      </div>
    {/key}
  {/if}
  <div class="mndw-app-shell__body">
    <Sidebar />
    <main class="mndw-app-shell__content">
      {@render children()}
    </main>
  </div>
</div>

<style>
.mndw-plugin-load-alert {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
}
</style>
