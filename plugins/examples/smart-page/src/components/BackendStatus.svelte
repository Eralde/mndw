<script lang="ts">
import type {Translator} from '@mndw/sdk';
import type {BackendAvailability} from '../services/page-controller';
import {backendStatusKey} from './backend';

interface Props {
  availability: BackendAvailability;
  i18n: Translator;
}

let {availability, i18n}: Props = $props();

const statusKey = $derived.by((): string | null =>
  backendStatusKey(availability)
);
</script>

{#if statusKey !== null}
  <p
    class="backend-status"
    data-testid="backend-status"
    role="status"
    aria-live="polite"
  >
    {i18n.t(statusKey)}
  </p>
{/if}

<style>
.backend-status {
  margin: 0;
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}
</style>
