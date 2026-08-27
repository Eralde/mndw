import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {mountEchoWidget} from './backend-echo.js';

export function createInstance(container: HTMLElement, context: PluginContext): PluginInstance {
  const widget = mountEchoWidget(container, context.backend, context.i18n);

  return {
    unmount(): void {
      widget.unmount();
    },
  };
}
