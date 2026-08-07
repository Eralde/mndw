import 'zone.js';
import '@angular/compiler';
import {createApplication} from '@angular/platform-browser';
import {EnvironmentInjector, createComponent} from '@angular/core';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {AppComponent} from './app/app.component';
import {type SettingsDialogArgs, openSettingsDialog} from './open-settings-dialog';
import {PLUGIN_STORAGE, RCI_MANAGER} from './tokens';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  let appRef: Awaited<ReturnType<typeof createApplication>> | null = null;
  let componentRef: ReturnType<typeof createComponent> | null = null;

  const appConfig = {
    providers: [
      {provide: RCI_MANAGER, useValue: ctx.rciManager},
      {provide: PLUGIN_STORAGE, useValue: ctx.storage},
    ],
  };

  createApplication(appConfig)
    .then((ref) => {
      appRef = ref;

      const injector = appRef.injector.get(EnvironmentInjector);
      const hostElement = el;

      hostElement.innerHTML = '';
      componentRef = createComponent(AppComponent, {hostElement, environmentInjector: injector});

      componentRef.setInput(
        'openSettings',
        (args: SettingsDialogArgs) => openSettingsDialog(ctx, ref, injector, args),
      );
      componentRef.setInput('setTileTitle', ctx.setTileTitle);

      appRef.attachView(componentRef.hostView);
    });

  return {
    unmount() {
      if (componentRef) {
        componentRef.destroy();
        componentRef = null;
      }

      if (appRef) {
        appRef.destroy();
        appRef = null;
      }
    },
  };
}
