<script lang="ts">
import type {Translator} from '@mndw/sdk';
import type {Snapshot} from '../model/api';
import {formatDateTime} from '../model/format';

interface Props {
  snapshot: Snapshot;
  i18n: Translator;
  locale?: string;
}

let {snapshot, i18n, locale}: Props = $props();

const displayLocale = $derived.by((): string => {
  return locale ?? i18n.locale;
});

const pairs = $derived.by(
  (): Array<{key: string; value: string; date?: string}> => {
    const {diagnostics} = snapshot;

    return [
      {key: 'diagnostics.checked-at',
        value: formatDateTime(diagnostics.checkedAt, displayLocale),
        date: diagnostics.checkedAt},
      {key: 'diagnostics.euid', value: String(diagnostics.euid)},
      {key: 'diagnostics.egid', value: String(diagnostics.egid)},
      {key: 'diagnostics.groups', value: diagnostics.groups.length === 0
        ? t('diagnostics.none')
        : diagnostics.groups.join(', ')},
      {key: 'diagnostics.utility', value: t(
        diagnostics.utility.available
          ? 'diagnostics.available'
          : 'diagnostics.unavailable',
      )},
      ...(diagnostics.utility.path === null
        ? []
        : [{key: 'diagnostics.utility-path', value: diagnostics.utility.path}]),
      ...(diagnostics.utility.version === null
        ? []
        : [{key: 'diagnostics.utility-version',
          value: diagnostics.utility.version}]),
      {key: 'diagnostics.smartd',
        value: t(`diagnostics.smartd-${diagnostics.smartd.status}`)},
    ];
  },
);

function t(key: string): string {
  return i18n.t(key);
}

function smartdReason(reason: string): string {
  const reasons: Record<string, string> = {
    'process view unavailable':
      'diagnostics.smartd-reason.process-view-unavailable',
    'process view incomplete':
      'diagnostics.smartd-reason.process-view-incomplete',
  };

  const key = reasons[reason];

  return key === undefined ? reason : t(key);
}
</script>

<details
  class="diagnostics"
  data-testid="diagnostics"
>
  <summary>{t('diagnostics.title')}</summary>
  <dl>
    {#each pairs as pair (pair.key)}
      <dt>{t(pair.key)}</dt>
      <dd>
        {#if pair.date === undefined}{pair.value}{:else}<time
            datetime={pair.date}
            title={pair.date}
          >{pair.value}</time>{/if}
      </dd>
    {/each}
  </dl>
  {#if snapshot.diagnostics.smartd.reason !== null}
    <p>{smartdReason(snapshot.diagnostics.smartd.reason)}</p>
  {/if}
  {#if snapshot.diagnostics.reasons.length > 0}
    <ul class="diagnostic-reasons">
      {#each snapshot.diagnostics.reasons as reason (reason)}
        <li>
          {#if reason === 'groups-unavailable'}{
              t('diagnostics.groups-unavailable')
            }
          {:else if reason === 'discovery-not-run'}{t('discovery-not-run')}
          {:else}{t('diagnostics.other-reason')}{/if}
        </li>
      {/each}
    </ul>
  {/if}
</details>

<style>
.diagnostics {
  container-type: inline-size;
  padding: var(--mndw-space-3);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  background: var(--mndw-surface-raised);
  color: var(--mndw-text);
  font-size: var(--mndw-text-sm);
  font-family: var(--mndw-font-sans);
}

summary {
  font-weight: var(--mndw-weight-semibold);
  font-size: var(--mndw-text-md);
  cursor: pointer;
}

.diagnostics[open] > summary {
  margin-bottom: var(--mndw-space-2);
}

p {
  margin: var(--mndw-space-2) 0 0;
}

dl {
  display: grid;
  grid-template-columns: minmax(0, max-content) minmax(0, 1fr);
  gap: var(--mndw-space-1) var(--mndw-space-3);
  margin: 0;
}

dt {
  color: var(--mndw-text-muted);
}

dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

/* The block sits in a full-width row now, but it follows its own width: a narrow page stacks each pair. */
@container (width < 30rem) {
  dl {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }

  dd:not(:last-child) {
    margin-bottom: var(--mndw-space-2);
  }
}

.diagnostic-reasons {
  display: grid;
  gap: var(--mndw-space-1);
  margin: var(--mndw-space-2) 0 0;
  padding-left: var(--mndw-space-4);
}
</style>
