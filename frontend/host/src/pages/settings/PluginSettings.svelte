<script lang="ts">
import PluginManager from './plugin-manager/PluginManager.svelte';

interface Props {
  capabilityVisible: boolean;
  capabilityAvailable: boolean;
}

let {capabilityVisible, capabilityAvailable}: Props = $props();
</script>

<section class="mndw-plugin-settings">
  <PluginManager
    {capabilityVisible}
    {capabilityAvailable}
  />
</section>
