<script lang="ts">
import type {Snippet} from 'svelte';
import Header from './Header.svelte';
import Sidebar from './Sidebar.svelte';

let {children}: {children: Snippet} = $props();
</script>

<div class="mndw-app-shell">
  <Header />
  <div class="mndw-app-shell__body">
    <Sidebar />
    <main class="mndw-app-shell__content">
      {@render children()}
    </main>
  </div>
</div>
