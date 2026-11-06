<script setup lang="ts">
import {useData} from 'vitepress';
import {VPSocialLinks} from 'vitepress/theme';
import VPSwitchAppearance from 'vitepress/dist/client/theme-default/components/VPSwitchAppearance.vue';

const {theme} = useData();
</script>

<template>
  <div class="sidebar-footer">
    <VPSwitchAppearance />
    <VPSocialLinks :links="theme.socialLinks ?? []" />
  </div>
</template>
