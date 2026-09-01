import {InjectionToken} from '@angular/core';
import type {RciManager} from '@rci-tools/core';
import type {Observable} from 'rxjs';
import type {BackendClient, DeviceInfo, OverlayService, PageRoute, PluginContext, PluginStorage} from '@mndw/sdk';

// Preserve plugin-local imports while sharing the SDK token identity used by the provider.
export {TRANSLATOR} from '@mndw/sdk/angular';

export const RCI_MANAGER = new InjectionToken<RciManager>('RCI_MANAGER');
export const OVERLAY = new InjectionToken<OverlayService>('OVERLAY');
export const DEVICE_INFO = new InjectionToken<DeviceInfo>('DEVICE_INFO');
export const ON_THEME_CHANGE = new InjectionToken<PluginContext['onThemeChange']>('ON_THEME_CHANGE');
export const PLUGIN_STORAGE = new InjectionToken<PluginStorage>('PLUGIN_STORAGE');
export const SHARED_PLUGIN_STORAGE = new InjectionToken<PluginStorage>('SHARED_PLUGIN_STORAGE');
export const MWSD_BACKEND = new InjectionToken<BackendClient | null>('MWSD_BACKEND', {
  factory: () => null,
});

export interface MwsRenameApi {
  renameNode(mac: string, isController: boolean, name: string): Observable<void>;
}

export const MWS_RENAME_API = new InjectionToken<MwsRenameApi>('MWS_RENAME_API');

export interface MwsMockOptions {
  mode: 'live' | 'large';
  extenders: number;
  clients: number;
}

export const MWS_MOCK_OPTIONS = new InjectionToken<MwsMockOptions>('MWS_MOCK_OPTIONS', {
  factory: () => ({mode: 'live', extenders: 0, clients: 0}),
});

export const MWS_PAGE_ROUTE = new InjectionToken<PageRoute | undefined>('MWS_PAGE_ROUTE', {
  factory: () => undefined,
});
