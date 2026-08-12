import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {DestroyRef, EnvironmentInjector, createComponent, inject} from '@angular/core';
import {createApplication} from '@angular/platform-browser';
import 'zone.js';
import '@angular/compiler';

import {AppComponent, TRANSLATOR} from './app.component';
import {createTranslatorSignals} from '@mndw/sdk/angular';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  let appRef: Awaited<ReturnType<typeof createApplication>> | null = null;
  let componentRef: ReturnType<typeof createComponent> | null = null;

  void createApplication({
    providers: [{
      provide: TRANSLATOR,
      useFactory: () => createTranslatorSignals(ctx.i18n, inject(DestroyRef)),
    }],
  }).then((ref) => {
    appRef = ref;

    const injector = ref.injector.get(EnvironmentInjector);

    el.innerHTML = '';
    componentRef = createComponent(AppComponent, {hostElement: el, environmentInjector: injector});
    componentRef.setInput('deviceName', ctx.hostInfo.deviceName);
    ref.attachView(componentRef.hostView);
  });

  return {
    unmount() {
      componentRef?.destroy();
      appRef?.destroy();
      el.innerHTML = '';
    },
  };
}
