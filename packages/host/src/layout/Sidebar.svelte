<script lang="ts">
import {appState} from '../state/app.svelte.js';
</script>

<nav
  class="mndw-sidebar"
  class:collapsed={appState.sidebarCollapsed}
>
  <a
    href="/"
    class="mndw-sidebar__link"
  >Dashboard</a>

  <div class="mndw-sidebar__spacer"></div>
  <a
    href="/settings"
    class="mndw-sidebar__link"
  >Settings</a>
</nav>
