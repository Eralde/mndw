import 'zone.js';
import '@angular/compiler';
import {type ApplicationRef, EnvironmentInjector, type Type, createComponent} from '@angular/core';
import {createApplication} from '@angular/platform-browser';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {MwsApiService} from './api/mws-api.service';
import {AppComponent} from './app/app.component';
import {LiveMapNodeDetailsSource} from './node-details-source';
import {openNodeDrawer} from './open-node-drawer';
import {MwsDataService} from './services/mws-data.service';
import {MwsWriteService} from './services/mws-write.service';
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
  let appRef: ApplicationRef | null = null;
  let componentRef: ReturnType<typeof createComponent> | null = null;
  let positions: NodePositionStore | null = null;
  let columns: NodeTableColumnsStore | null = null;
  let cancelled = false;
  const onThemeChange = ctx.onThemeChange.bind(ctx);
  const dataServiceProvider = options.dataService === undefined
    ? MwsDataService
    : {provide: MwsDataService, useClass: options.dataService};
  const mockOptionsProvider = options.mockOptions === undefined
    ? []
    : [{provide: MWS_MOCK_OPTIONS, useValue: options.mockOptions}];

  el.dataset.mndwTheme = ctx.hostInfo.theme;

  const unsubscribeTheme = onThemeChange((theme) => {
    el.dataset.mndwTheme = theme;
  });

  createApplication({
    providers: [
      {provide: RCI_MANAGER, useValue: ctx.rciManager},
      {provide: OVERLAY, useValue: ctx.overlay},
      {provide: HOST_INFO, useValue: ctx.hostInfo},
      {provide: MWSD_BACKEND, useValue: ctx.backend ?? null},
      {provide: MWS_PAGE_ROUTE, useValue: ctx.pageRoute},
      {provide: PLUGIN_STORAGE, useValue: ctx.storage},
      {provide: SHARED_PLUGIN_STORAGE, useValue: ctx.sharedStorage},
      ...mockOptionsProvider,
      {provide: ON_THEME_CHANGE, useValue: onThemeChange},
      MwsApiService,
      {provide: MWS_RENAME_API, useExisting: MwsApiService},
      dataServiceProvider,
      MwsWriteService,
      NodePositionStore,
      NodeTableColumnsStore,
    ],
  }).then((ref) => {
    if (cancelled) {
      ref.destroy();

      return;
    }

    appRef = ref;

    const injector = ref.injector.get(EnvironmentInjector);
    const dataService = ref.injector.get(MwsDataService);
    const detailsSource = new LiveMapNodeDetailsSource(dataService.snapshots$);

    positions = ref.injector.get(NodePositionStore);
    columns = ref.injector.get(NodeTableColumnsStore);

    el.innerHTML = '';
    componentRef = createComponent(AppComponent, {hostElement: el, environmentInjector: injector});
    componentRef.setInput('openNodeDrawer', (nodeId: string, title: string, onClose: () => void) => {
      openNodeDrawer(ctx, ref, injector, detailsSource, nodeId, title, onClose);
    });
    ref.attachView(componentRef.hostView);
  });

  return {
    unmount(): void {
      cancelled = true;
      unsubscribeTheme();
      ctx.overlay.closeAll();
      void positions?.flush();
      void columns?.flush();

      if (componentRef !== null) {
        componentRef.destroy();
        componentRef = null;
      }

      if (appRef !== null) {
        appRef.destroy();
        appRef = null;
      }

      positions = null;

      el.replaceChildren();
    },
  };
}
