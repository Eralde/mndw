<script lang="ts">
import {SvelteMap} from 'svelte/reactivity';
import type {PackageEntry, PackageInfo} from '../../services/opkg-client.js';
import {hostT} from '../../services/host-i18n.svelte.js';

export type PackageDetailState =
  | {status: 'pending'; promise: Promise<PackageInfo>}
  | {status: 'success'; info: PackageInfo}
  | {status: 'failure'; message: string};

export type PackageDetailCache = SvelteMap<string, PackageDetailState>;

type Props = {
  row: PackageEntry;
  value: PackageEntry;
  colId: string;
  cache: PackageDetailCache;
  load: (name: string) => void;
  retry: (name: string) => void;
};

let {row, value, colId, cache, load, retry}: Props = $props();
let packageName = $derived(value.name);
let detail = $derived.by(() => {
  return cache.get(packageName);
});

$effect(() => {
  load(packageName);
});
</script>

<div
  class="detail"
  data-col={colId}
  data-package={packageName}
>
  {#if detail?.status === 'pending' || detail === undefined}<p>
      {hostT('packages.loading')}
    </p>
  {:else if detail.status === 'failure'}<p role="alert">{detail.message}</p>
    <mndw-button
      variant="secondary"
      onclick={() => retry(packageName)}
    >{hostT('common.retry')}</mndw-button>
  {:else if detail.status === 'success'}
    <dl>
      <dt>{hostT('packages.description')}</dt>
      <dd>{detail.info.description}</dd>
      {#if detail.info.size}<dt>{hostT('packages.size')}</dt><dd>
          {detail.info.size}
        </dd>{/if}
      {#if detail.info.installedSize}<dt>
          {hostT('packages.installed-size')}
        </dt><dd>
          {detail.info.installedSize}
        </dd>{/if}
      {#if detail.info.installedTime}<dt>
          {hostT('packages.installed-time')}
        </dt><dd>
          {detail.info.installedTime}
        </dd>{/if}
      {#if detail.info.dependencies.length > 0}<dt>
          {hostT('packages.dependencies')}
        </dt><dd>{detail.info.dependencies.join(', ')}</dd>{/if}
    </dl>
  {/if}
</div>

<style>
.detail { color: var(--mndw-text); font-family: var(--mndw-font-sans); }
dl { display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr); gap: 8px 16px; margin: 0; max-width: 100%; }
dt { color: var(--mndw-text-subtle); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
</style>
