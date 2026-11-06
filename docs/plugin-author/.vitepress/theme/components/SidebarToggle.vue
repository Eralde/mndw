<script setup lang="ts">
import {nextTick, onMounted, onUnmounted, ref, watch} from 'vue';

import {observeSidebarOpen, SIDEBAR_TOGGLE_EVENT} from '../sidebar-toggle';

defineProps<{active?: boolean}>();
defineEmits<{click: []}>();

const open = ref(false);
let stopObserving: (() => void) | undefined;

function toggleSidebar(): void {
  window.dispatchEvent(new Event(SIDEBAR_TOGGLE_EVENT));
}

onMounted(() => {
  stopObserving = observeSidebarOpen(document, (isOpen) => {
    open.value = isOpen;
  });
});

onUnmounted(() => {
  stopObserving?.();
});

watch(open, async (isOpen): Promise<void> => {
  await nextTick();

  if (isOpen) {
    document.querySelector<HTMLElement>('#VPSidebarNav')?.focus();
    return;
  }

  const active = document.activeElement;
  const sidebar = document.querySelector('.VPSidebar');

  if (active === document.body || sidebar?.contains(active) === true) {
    document.querySelector<HTMLButtonElement>('.VPNavBarHamburger')?.focus();
  }
});
</script>

<template>
  <button
    type="button"
    class="VPNavBarHamburger sidebar-toggle"
    aria-label="Menu"
    aria-controls="VPSidebarNav"
    :aria-expanded="open"
    @click="toggleSidebar"
  >
    <span class="sidebar-toggle__lines" aria-hidden="true">
      <span class="sidebar-toggle__line sidebar-toggle__line--top" />
      <span class="sidebar-toggle__line sidebar-toggle__line--middle" />
      <span class="sidebar-toggle__line sidebar-toggle__line--bottom" />
    </span>
  </button>
</template>

<style scoped>
.sidebar-toggle {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 48px;
  height: var(--vp-nav-height);
}

.sidebar-toggle__lines {
  position: relative;
  width: 16px;
  height: 14px;
  overflow: hidden;
}

.sidebar-toggle__line {
  position: absolute;
  left: 0;
  width: 16px;
  height: 2px;
  background-color: var(--vp-c-text-1);
  transition: top 0.25s, background-color 0.5s, transform 0.25s;
}

.sidebar-toggle__line--top {
  top: 0;
}

.sidebar-toggle__line--middle {
  top: 6px;
  transform: translateX(8px);
}

.sidebar-toggle__line--bottom {
  top: 12px;
  transform: translateX(4px);
}

.sidebar-toggle:hover .sidebar-toggle__line--top {
  transform: translateX(4px);
}

.sidebar-toggle:hover .sidebar-toggle__line--middle {
  transform: translateX(0);
}

.sidebar-toggle:hover .sidebar-toggle__line--bottom {
  transform: translateX(8px);
}

.sidebar-toggle[aria-expanded='true'] .sidebar-toggle__line--top {
  top: 6px;
  transform: rotate(45deg);
}

.sidebar-toggle[aria-expanded='true'] .sidebar-toggle__line--middle {
  transform: translateX(16px);
}

.sidebar-toggle[aria-expanded='true'] .sidebar-toggle__line--bottom {
  top: 6px;
  transform: rotate(-45deg);
}

@media (min-width: 960px) {
  .sidebar-toggle {
    display: none;
  }
}
</style>
