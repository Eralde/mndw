<script lang="ts">
import {onMount} from 'svelte';
import {map} from 'rxjs/operators';
import {formatDeviceInfo} from '@mndw/ui';

const title = formatDeviceInfo('Svelte fixture');
onMount(() => map(() => title));
</script>

<div>{title}</div>
