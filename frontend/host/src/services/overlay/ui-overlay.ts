import {type OverlayRuntime, createPluginOverlayService} from './overlay-manager.svelte.js';

export function createUiOverlayService(runtime: OverlayRuntime) {
  return createPluginOverlayService('@mndw/ui', '@mndw/ui', runtime).service;
}
