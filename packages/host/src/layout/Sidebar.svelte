<script lang="ts">
import {pluginRegistry} from '../runtime/plugin-registry.js';
import {appState} from '../state/app.svelte.js';

// The registry is populated before authenticated startup builds this shell, so a plain
// copy-and-sort (label, then name) matches the router/picker ordering without a store.
const pagePlugins = pluginRegistry
  .getPages()
  .slice()
  .sort((a, b) =>
    a.entry.label.localeCompare(b.entry.label)
    || a.entry.name.localeCompare(b.entry.name)
  );
</script>

<nav
  class="mndw-sidebar"
  class:collapsed={appState.sidebarCollapsed}
>
  <a
    href="/"
    class="mndw-sidebar__link"
  >Dashboard</a>

  <a
    href="/packages"
    class="mndw-sidebar__link"
  >Package Manager</a>

  {#if pagePlugins.length > 0}
    <div class="mndw-sidebar__section-label">Plugins</div>
    {#each pagePlugins as plugin (plugin.entry.name)}
      <a
        href={plugin.entry.route}
        class="mndw-sidebar__link"
      >
        {plugin.entry.label}
      </a>
    {/each}
  {/if}

  <div class="mndw-sidebar__spacer"></div>
  <a
    href="/settings"
    class="mndw-sidebar__link"
  >Settings</a>
</nav>
