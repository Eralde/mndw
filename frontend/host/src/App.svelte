<script lang="ts">
import {Router} from 'sv-router';
import OverlayHost from './components/overlay/OverlayHost.svelte';
import LoginPage from './pages/login/LoginPage.svelte';
import {appState} from './state/app.svelte.js';
</script>

{#if !appState.authenticated}
  <LoginPage />
{:else if appState.ready}
  <Router />

  <!-- Global top-layer host for plugin overlays; stays mounted across navigation. -->
  <OverlayHost />
{:else}
  <div class="mndw-loading">Loading…</div>
{/if}
