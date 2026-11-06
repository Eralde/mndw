<script setup lang="ts">
import {computed} from 'vue';

const props = defineProps<{encodedHtml: string}>();

const html = computed(() => decodeURIComponent(props.encodedHtml));
</script>

<template>
  <ClientOnly>
    <div class="ui-demo__preview vp-raw" v-html="html" />
  </ClientOnly>
</template>
