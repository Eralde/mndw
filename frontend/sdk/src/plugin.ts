import type {PluginContext} from './context.js';

/** Widget tile size in grid units, passed to `onResize`. */
export interface PluginResizeSize {
  w: number;
  h: number;
}

export interface PluginInstance {
  unmount(): void | Promise<void>;
  /** Called once after mount with the tile's size in grid units, then on every resize. Desktop dashboard only; not called in the mobile layout. */
  onResize?(size: PluginResizeSize): void;
}

export interface MndwPlugin {
  createInstance(container: HTMLElement, context: PluginContext): PluginInstance | Promise<PluginInstance>;
}
