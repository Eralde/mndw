import {InjectionToken} from '@angular/core';
import type {RciManager} from '@rci-tools/core';
import type {HostInfo, OverlayService, PluginContext} from '@mndw/sdk';

export const RCI_MANAGER = new InjectionToken<RciManager>('RCI_MANAGER');
export const OVERLAY = new InjectionToken<OverlayService>('OVERLAY');
export const HOST_INFO = new InjectionToken<HostInfo>('HOST_INFO');
export const ON_THEME_CHANGE = new InjectionToken<PluginContext['onThemeChange']>('ON_THEME_CHANGE');
