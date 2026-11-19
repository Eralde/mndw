<script lang="ts">
import {onDestroy, untrack} from 'svelte';
import {Router} from 'sv-router';
import OverlayHost from './components/overlay/OverlayHost.svelte';
import ToastHost from './components/toast/ToastHost.svelte';
import LoginPage from './pages/login/LoginPage.svelte';
import {appState} from './state/app.svelte.js';
import {hostT} from './services/host-i18n.svelte.js';
import type {HostServices} from './host-services.js';
import {setHostServices} from './host-services-context.js';

const {services}: {services: HostServices} = $props();
const hostServices = untrack(() => services);

setHostServices(hostServices);
appState.theme = hostServices.theme.getTheme();
appState.locale = hostServices.locale.getLocale();
appState.localeSwitchPending = hostServices.locale.isLocaleSwitchPending();
const unsubscribeTheme = hostServices.theme.subscribeTheme((theme) => {
  appState.theme = theme;
});
const unsubscribeLocale = hostServices.locale.subscribeLocale((locale) => {
  appState.locale = locale;
});
const unsubscribeLocalePending = hostServices.locale.subscribeLocalePending(
  (pending) => {
    appState.localeSwitchPending = pending;
  },
);

onDestroy(() => {
  unsubscribeTheme();
  unsubscribeLocale();
  unsubscribeLocalePending();
});
</script>

<!-- Global top-layer host stays mounted across login, loading, and navigation. -->
<OverlayHost runtime={hostServices.overlayRuntime} />
<ToastHost />

{#if !appState.authenticated}
  <LoginPage />
{:else if appState.ready}
  {#key appState.pluginLoadRevision}
    <Router />
  {/key}
{:else}
  <div
    class="mndw-loading"
    data-locale={appState.locale}
    role="status"
    aria-busy="true"
  >
    {hostT('app.loading')}
  </div>
{/if}
