import 'zone.js';
import '@angular/compiler';
import type {Type} from '@angular/core';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createAngularPluginInstance, provideTranslator} from '@mndw/sdk/angular';
import {MwsApiService} from './api/mws-api.service';
import {AppComponent} from './app/app.component';
import {LiveMapNodeDetailsSource} from './node-details-source';
import {openNodeDrawer} from './open-node-drawer';
import {MwsDataService} from './services/mws-data.service';
import {MwsdStatusService} from './services/mwsd-status.service';
import {MwsWriteService} from './services/mws-write.service';
import {ExtraFeaturesBannerStore} from './services/extra-features-banner.store';
import {NodePositionStore} from './services/node-position.store';
import {NodeTableColumnsStore} from './services/node-table-columns.store';
import {
  DEVICE_INFO,
  HOST_NAVIGATION,
  MWSD_BACKEND,
  MWS_MOCK_OPTIONS,
  MWS_PAGE_ROUTE,
  MWS_RENAME_API,
  type MwsMockOptions,
  OVERLAY,
  PLUGIN_STORAGE,
  RCI_MANAGER,
  SHARED_PLUGIN_STORAGE,
  THEME$,
} from './tokens';

export interface MwsInstanceOptions {
  readonly dataService?: Type<MwsDataService>;
  readonly mockOptions?: MwsMockOptions;
}

export function createMwsMapInstance(
  el: HTMLElement,
  ctx: PluginContext,
  options: MwsInstanceOptions = {},
): PluginInstance {
  let positions: NodePositionStore | null = null;
  let columns: NodeTableColumnsStore | null = null;
  const themeSubscription = ctx.theme$.subscribe((theme) => {
    el.dataset.mndwTheme = theme;
  });
  const dataServiceProvider = options.dataService === undefined
    ? MwsDataService
    : {provide: MwsDataService, useClass: options.dataService};
  const mockOptionsProvider = options.mockOptions === undefined
    ? []
    : [{provide: MWS_MOCK_OPTIONS, useValue: options.mockOptions}];

  el.dataset.mndwTheme = ctx.theme;

  const setLocaleLabel = (): void => {
    const title = ctx.i18n.t('title');

    el.setAttribute('aria-label', title);

    if (ctx.kind === 'widget') {
      ctx.setTileTitle?.(title);
    }
  };

  setLocaleLabel();

  const localeSubscription = ctx.i18n.change$.subscribe(setLocaleLabel);

  return createAngularPluginInstance(el, {
    rootComponent: AppComponent,
    providers: [
      {provide: RCI_MANAGER, useValue: ctx.rciManager},
      {provide: HOST_NAVIGATION, useValue: ctx.navigation},
      {provide: OVERLAY, useValue: ctx.overlay},
      {provide: DEVICE_INFO, useValue: ctx.deviceInfo},
      {provide: MWSD_BACKEND, useValue: ctx.backend ?? null},
      {provide: MWS_PAGE_ROUTE, useValue: ctx.kind === 'page' ? ctx.pageRoute : undefined},
      {provide: PLUGIN_STORAGE, useValue: ctx.storage},
      {provide: SHARED_PLUGIN_STORAGE, useValue: ctx.sharedStorage},
      ...mockOptionsProvider,
      {provide: THEME$, useValue: ctx.theme$},
      provideTranslator(ctx.i18n),
      MwsApiService,
      {provide: MWS_RENAME_API, useExisting: MwsApiService},
      MwsdStatusService,
      dataServiceProvider,
      MwsWriteService,
      ExtraFeaturesBannerStore,
      NodePositionStore,
      NodeTableColumnsStore,
    ],
    configure: ({appRef, injector, component}) => {
      const dataService = injector.get(MwsDataService);
      const detailsSource = new LiveMapNodeDetailsSource(dataService.snapshots$);

      positions = injector.get(NodePositionStore);
      columns = injector.get(NodeTableColumnsStore);
      component.setInput('openNodeDrawer', (nodeId: string, title: string, onClose: () => void) => {
        openNodeDrawer(ctx, appRef, detailsSource, nodeId, title, onClose);
      });
    },
    onUnmount: () => {
      themeSubscription.unsubscribe();
      localeSubscription.unsubscribe();
      ctx.overlay.closeAll();
      void positions?.flush();
      void columns?.flush();
    },
  });
}
