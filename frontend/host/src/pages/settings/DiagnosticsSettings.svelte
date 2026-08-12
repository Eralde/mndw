<script lang="ts">
import {downloadDiagnostics} from '../../services/diagnostics.service.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import {appState} from '../../state/app.svelte.js';

let diagnosticsLoading = $state(false);
let diagnosticsError = $state('');

async function downloadHostDiagnostics(): Promise<void> {
  diagnosticsLoading = true;
  diagnosticsError = '';
  try {
    await downloadDiagnostics();
  } catch {
    diagnosticsError = hostT('settings.diagnostics-failed');
  } finally {
    diagnosticsLoading = false;
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
  >{
    diagnosticsLoading
    ? hostT('settings.downloading')
    : hostT('settings.download-diagnostics')
  }</mndw-button>
  {#if diagnosticsError}
    <p role="alert">{diagnosticsError}</p>
  {/if}
</section>
