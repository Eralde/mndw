<script lang="ts">
import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {hostT} from '../../../services/host-i18n.svelte.js';

interface Props {
  entry: PluginListEntry;
}

let {entry}: Props = $props();

let routes = $derived(Object.entries(entry.backend.routes ?? {}));
let packages = $derived(entry.review?.packages ?? []);
let args = $derived(entry.review?.args ?? []);
let publicRoutes = $derived(entry.review?.publicRoutes ?? []);
let permissions = $derived(entry.permissions ?? []);
</script>

<div class="mndw-cap">
  {#if entry.review !== undefined}
    <p class="mndw-cap__kind">
      {
        hostT(
          entry.review.kind === 'service'
            ? 'settings.plugin-manager.backend-kind-service'
            : 'settings.plugin-manager.backend-kind-exec',
        )
      }
    </p>
  {/if}

  {#if packages.length > 0}
    <section class="mndw-cap__section">
      <h4>{hostT('settings.plugin-manager.packages')}</h4>
      <ul>
        {#each packages as packageName (packageName)}
          <li>{packageName}</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if args.length > 0}
    <section class="mndw-cap__section">
      <h4>{hostT('settings.plugin-manager.service-args')}</h4>
      <ul>
        {#each args as arg, index (`${index}:${arg}`)}
          <li>{arg}</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if routes.length > 0}
    <section class="mndw-cap__section">
      <h4>{hostT('settings.plugin-manager.routes')}</h4>
      <ul>
        {#each routes as [id, route] (id)}
          <li>
            {id}: {
              route.transport === 'http'
              ? `${route.method ?? 'GET'} `
              : ''
            }{route.path}{
              route.protocols?.length
              ? ` (${route.protocols.join(', ')})`
              : ''
            }
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if publicRoutes.length > 0}
    <section class="mndw-cap__section">
      <h4>{hostT('settings.plugin-manager.public-routes')}</h4>
      <ul>
        {#each publicRoutes as routeId (routeId)}
          <li>{routeId}</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if permissions.length > 0}
    <section class="mndw-cap__section">
      <h4>{hostT('settings.plugin-manager.permissions')}</h4>
      <ul>
        {#each permissions as permission (permission)}
          <li>{permission}</li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
.mndw-cap {
  display: grid;
  gap: var(--mndw-space-3);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
  line-height: var(--mndw-leading);
}

.mndw-cap__section {
  display: grid;
  gap: var(--mndw-space-1);
}

.mndw-cap__kind {
  margin: 0;
}

.mndw-cap h4 {
  margin: 0;
  font-size: var(--mndw-text-sm);
  font-weight: var(--mndw-weight-semibold);
}

.mndw-cap ul {
  display: grid;
  gap: var(--mndw-space-1);
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--mndw-text-muted);
  font-family: var(--mndw-font-mono);
  font-size: var(--mndw-text-xs);
}
</style>
