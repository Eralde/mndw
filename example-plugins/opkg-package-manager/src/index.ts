import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import PackageManager from './PackageManager.svelte';

export function createInstance(container: HTMLElement, _context: PluginContext): PluginInstance {
  const app = mount(PackageManager, {target: container});

  return {
    unmount(): void {
      void unmount(app);
    },
  };
}
