<script lang="ts">
import type {PluginBackendDescriptor} from '../../../runtime/plugin-types.js';

interface Props {
  descriptor: PluginBackendDescriptor;
}

let {descriptor}: Props = $props();

let routes = $derived(Object.entries(descriptor.routes ?? {}));
</script>

<div class="mndw-cap">
  {#if routes.length > 0}
    <section class="mndw-cap__section">
      <h4>Routes</h4>
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
