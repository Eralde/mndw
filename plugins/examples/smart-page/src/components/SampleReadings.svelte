<script lang="ts">
import type {Translator} from '@mndw/sdk';
import type {Sample} from '../model/api';
import {
  attributeFailing,
  counterNameKey,
  counterNeedsAttention,
  formatCounter,
  formatNullable,
  hasFaultCounter,
  indicatorCounters,
} from '../model/format';
import DefinitionList, {type Row} from './DefinitionList.svelte';

interface Props {
  sample: Sample;
  i18n: Translator;
  locale?: string;
}

let {sample, i18n, locale}: Props = $props();

const displayLocale = $derived.by((): string => {
  return locale ?? i18n.locale;
});
const counters = $derived.by(() => {
  return indicatorCounters(sample.counters);
});
const rows = $derived.by((): Row[] => {
  return counters.map((counter) => {
    const nameKey = counterNameKey(counter.name);

    return {
      key: counter.name,
      label: nameKey === null ? counter.name : t(nameKey),
      value: formatCounter(counter, displayLocale, t),
      warning: counterNeedsAttention(counter),
      testId: `counter-${counter.name}`,
    };
  });
});

function t(key: string, values?: Record<string, unknown>): string {
  return i18n.t(key, values);
}
</script>

{#if counters.length > 0}
  <section
    class="card indicators"
    aria-labelledby="indicators-title"
  >
    <h3 id="indicators-title">{t('details.indicators')}</h3>
    {#if hasFaultCounter(counters)}
      <p class="muted">{t('counter.hint')}</p>
    {/if}
    <DefinitionList
      {rows}
      warningLabel={t('flag.attention')}
    />
  </section>
{/if}
{#if sample.attributes.length > 0}
  <details
    class="card attributes"
    data-testid="attributes"
  >
    <summary>
      {t('details.attributes', {count: sample.attributes.length})}
    </summary>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th class="number">{t('field.attribute-id')}</th>
            <th>{t('field.attribute')}</th>
            <th class="number">{t('field.raw')}</th>
            <th class="number">{t('field.normalized')}</th>
            <th class="number">{t('field.threshold')}</th>
          </tr>
        </thead>
        <tbody>
          {#each sample.attributes as
            attribute,
            index
            (`${attribute.id ?? 'none'}-${index}`)
          }
            <tr class:failing={attributeFailing(attribute)}>
              <td class="number">{formatNullable(attribute.id)}</td>
              <td>
                {attribute.name}{#if attributeFailing(attribute)}<span
                    class="visually-hidden"
                  >{` ${t('flag.attention')}`}</span>{/if}
              </td>
              <td
                class="number"
                data-testid="attribute-raw"
              >
                {formatNullable(attribute.raw)}
              </td>
              <td
                class="number"
                data-testid="attribute-normalized"
              >
                {formatNullable(attribute.normalized)}
              </td>
              <td
                class="number"
                data-testid="attribute-threshold"
              >
                {formatNullable(attribute.threshold)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </details>
{/if}

<style>
.card {
  container-type: inline-size;
  padding: var(--mndw-space-3);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  background: var(--mndw-surface-raised);
}

section.card {
  display: grid;
  gap: var(--mndw-space-2);
}

h3,
p {
  margin: 0;
}

h3,
summary {
  font-weight: var(--mndw-weight-semibold);
  font-size: var(--mndw-text-md);
}

summary {
  cursor: pointer;
}

details[open] > summary {
  margin-bottom: var(--mndw-space-2);
}

.muted {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.table-scroll {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}

th,
td {
  position: relative;
  padding: var(--mndw-space-1) var(--mndw-space-2);
  border-bottom: 1px solid var(--mndw-border);
  overflow-wrap: anywhere;
}

.number {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

tr.failing {
  color: var(--mndw-warning);
}

.visually-hidden {
  position: absolute;
  overflow: hidden;
  clip-path: inset(50%);
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  white-space: nowrap;
}
</style>
