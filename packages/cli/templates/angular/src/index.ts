import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {EnvironmentInjector, createComponent} from '@angular/core';
import {createApplication} from '@angular/platform-browser';
import 'zone.js';
import '@angular/compiler';

import {AppComponent} from './app.component';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  let appRef: Awaited<ReturnType<typeof createApplication>> | null = null;
  let componentRef: ReturnType<typeof createComponent> | null = null;

  void createApplication().then((ref) => {
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
