import type {RciManager} from '@rci-tools/core';

export const PLUGIN_RCI_MANAGER_METHODS = [
  'execute',
  'queue',
  'initBackgroundProcess',
  'queueBackgroundProcess',
] as const satisfies readonly (keyof RciManager)[];

export type PluginRciManagerMethod = (typeof PLUGIN_RCI_MANAGER_METHODS)[number];

export type PluginRciManager = Pick<RciManager, PluginRciManagerMethod>;
