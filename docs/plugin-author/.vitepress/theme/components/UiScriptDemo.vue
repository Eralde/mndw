<script setup lang="ts">
import {onBeforeUnmount, onMounted, ref} from 'vue';

const props = defineProps<{
  mount: (root: HTMLElement) => void | (() => void);
}>();

const root = ref<HTMLDivElement>();
let cleanup: void | (() => void);

onMounted(() => {
  if (root.value !== undefined) {
    cleanup = props.mount(root.value);
  }
});

onBeforeUnmount(() => {
  cleanup?.();
});
</script>

<template>
  <div ref="root" class="ui-demo__preview vp-raw"></div>
</template>
