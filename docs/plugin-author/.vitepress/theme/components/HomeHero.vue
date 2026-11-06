<script setup lang="ts">
import {VPButton} from 'vitepress/theme';

const installLink = '/install';
const projectSetupLink = '/guides/project-setup';
</script>

<template>
  <section class="home-hero" aria-labelledby="home-hero-name">
    <h1 id="home-hero-name" class="home-hero__name">mndw</h1>
    <p class="home-hero__headline">Modular web UI for Keenetic/Netcraze routers</p>
    <p class="home-hero__tagline">
      Runs on the router under Entware, next to the stock web interface. Extend it with plugins you write yourself.
    </p>
    <div class="home-hero__actions">
      <VPButton theme="brand" text="Install mndw" :href="installLink" />
      <VPButton theme="alt" text="Build a plugin" :href="projectSetupLink" />
    </div>
  </section>
</template>
