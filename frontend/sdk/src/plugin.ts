import type {PluginContext} from './context.js';

/** Widget tile size in grid units, passed to `onResize`. */
export interface PluginResizeSize {
  w: number;
  h: number;
}

export interface PluginInstance {
  unmount(): void | Promise<void>;
  /** Called on tile resize with the new size in grid units. Widgets only. */
  onResize?(size: PluginResizeSize): void;
}

export interface MndwPlugin {
  createInstance(container: HTMLElement, context: PluginContext): PluginInstance | Promise<PluginInstance>;
}
