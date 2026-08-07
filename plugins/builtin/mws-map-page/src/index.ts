import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {parseMockOptions} from './mock/mock-options';
import {createMwsMapInstance} from './mws-map-instance';
import {MwsMockDataService} from './services/mws-mock-data.service';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  const mockOptions = parseMockOptions(el.ownerDocument.defaultView?.location.search ?? '');

  return createMwsMapInstance(
    el,
    ctx,
    mockOptions.mode === 'large'
      ? {dataService: MwsMockDataService, mockOptions}
      : {mockOptions},
  );
}
