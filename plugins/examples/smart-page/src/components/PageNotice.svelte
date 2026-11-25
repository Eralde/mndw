<script lang="ts">
import type {Translator} from '@mndw/sdk';
import {errorMessageKey} from '../model/format';
import type {PageNotice as Notice} from '../services/page-controller';

interface Props {
  notice: Notice | null;
  i18n: Translator;
}

let {notice, i18n}: Props = $props();

const message = $derived.by((): string | null => {
  if (notice === null) { return null; }
  if (notice.kind === 'backend-recovered') { return t('backend.recovered'); }
  if (notice.kind === 'device-not-selected') {
    return t('notice.device-not-selected');
  }
  if (notice.kind === 'busy') { return t('notice.busy'); }
  if (notice.kind === 'disconnected') { return t('notice.disconnected'); }

  return t(errorMessageKey(notice.code));
});

function t(key: string): string {
  return i18n.t(key);
}
</script>

{#if message !== null}
  <p
    class="page-notice"
    role="status"
    data-testid="page-notice"
  >
    {message}
  </p>
{/if}

<style>
.page-notice {
  margin: 0;
  padding: var(--mndw-space-3);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  background: var(--mndw-surface-raised);
  color: var(--mndw-text);
}
</style>
