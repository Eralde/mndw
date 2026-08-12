<script lang="ts">
import {Router} from 'sv-router';
import OverlayHost from './components/overlay/OverlayHost.svelte';
import LoginPage from './pages/login/LoginPage.svelte';
import {appState} from './state/app.svelte.js';
import {hostT} from './services/host-i18n.svelte.js';
</script>

<!-- Global top-layer host stays mounted across login, loading, and navigation. -->
<OverlayHost />

{#if !appState.authenticated}
  <LoginPage />
{:else if appState.ready}
  <Router />
{:else}
  <div
    class="mndw-loading"
    data-locale={appState.locale}
  >
    {hostT('app.loading')}
  </div>
{/if}
