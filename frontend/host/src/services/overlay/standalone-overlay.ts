import type {OverlayService} from '@mndw/sdk';
import {mount, unmount} from 'svelte';
import OverlayHost from '../../components/overlay/OverlayHost.svelte';
import {createPluginOverlayService} from './overlay-manager.svelte.js';

export interface StandaloneOverlay {
  service: OverlayService;
  destroy: () => void;
}

export function mountStandaloneOverlay(target: HTMLElement): StandaloneOverlay {
  const bundle = createPluginOverlayService('@mndw/ui', '@mndw/ui');
  const host = mount(OverlayHost, {target});

  return {
    service: bundle.service,
    destroy: () => {
      bundle.dispose('plugin-unmount');
      void unmount(host);
    },
  };
}
