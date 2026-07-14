import {InjectionToken} from '@angular/core';
import type {RciManager} from '@rci-tools/core';
import type {PluginStorage} from '@mndw/sdk';

export const RCI_MANAGER = new InjectionToken<RciManager>('RCI_MANAGER');
export const PLUGIN_STORAGE = new InjectionToken<PluginStorage>('PLUGIN_STORAGE');
