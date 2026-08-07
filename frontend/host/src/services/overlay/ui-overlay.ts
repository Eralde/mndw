import {createPluginOverlayService} from './overlay-manager.svelte.js';

const {service} = createPluginOverlayService('@mndw/ui', '@mndw/ui');

export const uiOverlayService = service;
