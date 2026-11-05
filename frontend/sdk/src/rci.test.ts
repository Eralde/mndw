import {expect, expectTypeOf, it} from 'vitest';
import {PLUGIN_RCI_MANAGER_METHODS, type PluginRciManager} from './rci.js';

it('exposes exactly the plugin RCI manager methods', () => {
  expect(PLUGIN_RCI_MANAGER_METHODS).toEqual(['execute', 'queue', 'initBackgroundProcess', 'queueBackgroundProcess']);
  expectTypeOf<keyof PluginRciManager>().toEqualTypeOf<
    'execute' | 'queue' | 'initBackgroundProcess' | 'queueBackgroundProcess'
  >();
});
