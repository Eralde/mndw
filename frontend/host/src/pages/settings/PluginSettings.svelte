<script lang="ts">
import PluginManager from './plugin-manager/PluginManager.svelte';

interface Props {
  permissionVisible: boolean;
  permissionAvailable: boolean;
}

let {permissionVisible, permissionAvailable}: Props = $props();
</script>

<section class="mndw-plugin-settings">
  <PluginManager
    {permissionVisible}
    {permissionAvailable}
  />
</section>
