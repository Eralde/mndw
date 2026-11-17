<script lang="ts">
import {onDestroy} from 'svelte';
import {downloadDiagnostics} from '../../services/diagnostics.service.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import {toast} from '../../services/toast/toast.svelte.js';
import {appState} from '../../state/app.svelte.js';

const DIAGNOSTICS_DOWNLOAD_TOAST_KEY = 'settings.diagnostics.download';

let diagnosticsLoading = $state(false);
let destroyed = false;

onDestroy(() => {
  destroyed = true;
});

async function downloadHostDiagnostics(): Promise<void> {
  diagnosticsLoading = true;

  try {
    await downloadDiagnostics();
    if (destroyed) {
      return;
    }
    toast.dismissKey(DIAGNOSTICS_DOWNLOAD_TOAST_KEY);
  } catch {
    if (destroyed) {
      return;
    }
    toast.error(hostT('settings.diagnostics-failed'), {
      key: DIAGNOSTICS_DOWNLOAD_TOAST_KEY,
    });
  } finally {
    if (!destroyed) {
      diagnosticsLoading = false;
    }
  }
}
</script>

<section
  class="mndw-diagnostics-settings"
  data-locale={appState.locale}
  aria-label={hostT('settings.diagnostics-tab')}
>
  <h3>{hostT('settings.diagnostics-tab')}</h3>
  <p>{hostT('settings.diagnostics-description')}</p>
  <mndw-button
    variant="secondary"
    disabled={diagnosticsLoading}
    onclick={() => void downloadHostDiagnostics()}
  >
    {
      diagnosticsLoading
      ? hostT('settings.downloading')
      : hostT('settings.download-diagnostics')
    }
  </mndw-button>
</section>

<style>
.mndw-diagnostics-settings {
  display: grid;
  gap: var(--mndw-space-2);
}

.mndw-diagnostics-settings h3,
.mndw-diagnostics-settings p {
  margin: 0;
}
</style>
