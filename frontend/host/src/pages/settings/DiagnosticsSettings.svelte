<script lang="ts">
import {downloadDiagnostics} from '../../services/diagnostics.service.js';

let diagnosticsLoading = $state(false);
let diagnosticsError = $state('');

async function downloadHostDiagnostics(): Promise<void> {
  diagnosticsLoading = true;
  diagnosticsError = '';
  try {
    await downloadDiagnostics();
  } catch {
    diagnosticsError = 'Diagnostics download failed';
  } finally {
    diagnosticsLoading = false;
  }
}
</script>

<section
  class="mndw-diagnostics-settings"
  aria-label="Diagnostics"
>
  <h3>Diagnostics</h3>
  <p>Download recent daemon and plugin runtime state for troubleshooting.</p>
  <mndw-button
    variant="secondary"
    disabled={diagnosticsLoading}
    onclick={() => void downloadHostDiagnostics()}
  >{diagnosticsLoading ? 'Downloading…' : 'Download diagnostics'}</mndw-button>
  {#if diagnosticsError}
    <p role="alert">{diagnosticsError}</p>
  {/if}
</section>
