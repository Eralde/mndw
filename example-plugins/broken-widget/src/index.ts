import type {PluginContext, PluginInstance} from '@mndw/sdk';

/**
 * Intentionally broken example: the module loads cleanly (so the daemon lists it and
 * the add-panel offers it), but constructing an instance throws. Adding it to the grid
 * exercises the host's per-tile error boundary; the host must survive.
 */
export function createInstance(_el: HTMLElement, _ctx: PluginContext): PluginInstance {
  throw new Error('broken-widget: intentional failure to demonstrate the error boundary');
}
