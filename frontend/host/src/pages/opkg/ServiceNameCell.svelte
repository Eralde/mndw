<script lang="ts">
import type {ServiceRow} from './service-row.js';

type Props = {row: ServiceRow};

let {row}: Props = $props();
</script>

<strong>{row.service.label}</strong><small>{row.service.name}</small>

<style>
small { display: block; color: var(--mndw-text-subtle); }
</style>
