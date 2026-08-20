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
import {MwsWriteService} from './services/mws-write.service';
import {ExtraFeaturesBannerStore} from './services/extra-features-banner.store';
import {NodePositionStore} from './services/node-position.store';
import {NodeTableColumnsStore} from './services/node-table-columns.store';
import {
  HOST_INFO,
  MWSD_BACKEND,
  MWS_MOCK_OPTIONS,
  MWS_PAGE_ROUTE,
  MWS_RENAME_API,
  type MwsMockOptions,
  ON_THEME_CHANGE,
  OVERLAY,
  PLUGIN_STORAGE,
  RCI_MANAGER,
  SHARED_PLUGIN_STORAGE,
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
  const onThemeChange = ctx.onThemeChange.bind(ctx);
  const dataServiceProvider = options.dataService === undefined
    ? MwsDataService
    : {provide: MwsDataService, useClass: options.dataService};
  const mockOptionsProvider = options.mockOptions === undefined
    ? []
    : [{provide: MWS_MOCK_OPTIONS, useValue: options.mockOptions}];

  el.dataset.mndwTheme = ctx.hostInfo.theme;

  const setLocaleLabel = (): void => {
    const title = ctx.i18n.t('title');

    el.setAttribute('aria-label', title);

    if (ctx.kind === 'widget') {
      ctx.setTileTitle?.(title);
    }
  };

  setLocaleLabel();

  const unsubscribeLocale = ctx.i18n.onChange(setLocaleLabel);

  const unsubscribeTheme = onThemeChange((theme) => {
    el.dataset.mndwTheme = theme;
  });

  return createAngularPluginInstance(el, {
    rootComponent: AppComponent,
    providers: [
      {provide: RCI_MANAGER, useValue: ctx.rciManager},
      {provide: OVERLAY, useValue: ctx.overlay},
      {provide: HOST_INFO, useValue: ctx.hostInfo},
      {provide: MWSD_BACKEND, useValue: ctx.backend ?? null},
      {provide: MWS_PAGE_ROUTE, useValue: ctx.kind === 'page' ? ctx.pageRoute : undefined},
      {provide: PLUGIN_STORAGE, useValue: ctx.storage},
      {provide: SHARED_PLUGIN_STORAGE, useValue: ctx.sharedStorage},
      ...mockOptionsProvider,
      {provide: ON_THEME_CHANGE, useValue: onThemeChange},
      provideTranslator(ctx.i18n),
      MwsApiService,
      {provide: MWS_RENAME_API, useExisting: MwsApiService},
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
      unsubscribeTheme();
      unsubscribeLocale();
      ctx.overlay.closeAll();
      void positions?.flush();
      void columns?.flush();
    },
  });
}
