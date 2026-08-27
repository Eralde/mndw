import {InjectionToken} from '@angular/core';
import type {RciManager} from '@rci-tools/core';
import type {PluginStorage} from '@mndw/sdk';

// Preserve plugin-local imports while sharing the SDK token identity used by the provider.
export {TRANSLATOR} from '@mndw/sdk/angular';

export const RCI_MANAGER = new InjectionToken<RciManager>('RCI_MANAGER');
export const PLUGIN_STORAGE = new InjectionToken<PluginStorage>('PLUGIN_STORAGE');
