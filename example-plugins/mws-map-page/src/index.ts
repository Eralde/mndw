import 'zone.js';
import '@angular/compiler';
import {type ApplicationRef, EnvironmentInjector, createComponent} from '@angular/core';
import {createApplication} from '@angular/platform-browser';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {MwsApiService} from './api/mws-api.service';
import {AppComponent} from './app/app.component';
import {LiveMapNodeDetailsSource} from './node-details-source';
import {openNodeDrawer} from './open-node-drawer';
import {MwsDataService} from './services/mws-data.service';
import {HOST_INFO, ON_THEME_CHANGE, OVERLAY, RCI_MANAGER} from './tokens';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  let appRef: ApplicationRef | null = null;
  let componentRef: ReturnType<typeof createComponent> | null = null;
  let cancelled = false;
  const onThemeChange = ctx.onThemeChange.bind(ctx);

  el.dataset.mndwTheme = ctx.hostInfo.theme;

  const unsubscribeTheme = onThemeChange((theme) => {
    el.dataset.mndwTheme = theme;
  });

  createApplication({
    providers: [
      {provide: RCI_MANAGER, useValue: ctx.rciManager},
      {provide: OVERLAY, useValue: ctx.overlay},
      {provide: HOST_INFO, useValue: ctx.hostInfo},
      {provide: ON_THEME_CHANGE, useValue: onThemeChange},
      MwsApiService,
      MwsDataService,
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

    el.innerHTML = '';
    componentRef = createComponent(AppComponent, {hostElement: el, environmentInjector: injector});
    componentRef.setInput('openNodeDrawer', (nodeId: string, title: string) => {
      openNodeDrawer(ctx, ref, injector, detailsSource, nodeId, title);
    });
    ref.attachView(componentRef.hostView);
  });

  return {
    unmount(): void {
      cancelled = true;
      unsubscribeTheme();
      ctx.overlay.closeAll();

      if (componentRef !== null) {
        componentRef.destroy();
        componentRef = null;
      }

      if (appRef !== null) {
        appRef.destroy();
        appRef = null;
      }

      el.replaceChildren();
    },
  };
}
