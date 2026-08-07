import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createMwsMapInstance} from './mws-map-instance';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  return createMwsMapInstance(el, ctx);
}
