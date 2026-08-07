<script lang="ts">
import type {PluginBackendDescriptor} from '../../../runtime/plugin-types.js';

interface Props {
  descriptor: PluginBackendDescriptor;
}

let {descriptor}: Props = $props();

let endpoints = $derived(Object.entries(descriptor.endpoints));
let websockets = $derived(Object.entries(descriptor.websockets));
</script>

<div class="mndw-cap">
  {#if descriptor.opkg.length > 0}
    <section class="mndw-cap__section">
      <h4>Packages</h4>
      <ul>
        {#each descriptor.opkg as packageName (packageName)}
          <li>{packageName}</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if endpoints.length > 0}
    <section class="mndw-cap__section">
      <h4>Endpoints</h4>
      <ul>
        {#each endpoints as [id, endpoint] (id)}
          <li>{id}: {endpoint.method} {endpoint.path}</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if websockets.length > 0}
    <section class="mndw-cap__section">
      <h4>WebSockets</h4>
      <ul>
        {#each websockets as [id, websocket] (id)}
          <li>
            {id}: {websocket.path}{
              websocket.protocols?.length
              ? ` (${websocket.protocols.join(', ')})`
              : ''
            }
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if descriptor.daemon}
    <div class="mndw-cap__row">Daemon declaration</div>
  {/if}

  {#if descriptor.public}
    <div class="mndw-cap__public">
      <strong>public: bypasses the session gate</strong>
      <span>reachable without login</span>
    </div>
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

.mndw-cap__row,
.mndw-cap__public {
  padding: var(--mndw-space-2);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
}

.mndw-cap__public {
  display: grid;
  gap: var(--mndw-space-1);
  border-color: var(--mndw-warning);
  color: var(--mndw-text);
}

.mndw-cap__public span {
  color: var(--mndw-text-subtle);
}
</style>
