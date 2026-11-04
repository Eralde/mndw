<script setup lang="ts">
import {computed} from 'vue';
import {formatDeviceInfo} from '@mndw/ui';

const title = computed(() => formatDeviceInfo('Vue fixture'));
</script>

<template><div>{{ title }}</div></template>
