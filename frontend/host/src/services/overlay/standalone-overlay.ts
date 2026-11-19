import type {OverlayService} from '@mndw/sdk';
import {mount, unmount} from 'svelte';
import OverlayHost from '../../components/overlay/OverlayHost.svelte';
import {createOverlayRuntime, createPluginOverlayService} from './overlay-manager.svelte.js';

export interface StandaloneOverlay {
  service: OverlayService;
  destroy: () => void;
}

export function mountStandaloneOverlay(target: HTMLElement): StandaloneOverlay {
  const runtime = createOverlayRuntime();
  const bundle = createPluginOverlayService('@mndw/ui', '@mndw/ui', runtime);
  const host = mount(OverlayHost, {target, props: {runtime}});

  return {
    service: bundle.service,
    destroy: () => {
      bundle.dispose('plugin-unmount');
      void unmount(host);
    },
  };
}
