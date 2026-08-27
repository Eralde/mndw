import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createAngularPluginInstance, provideTranslator} from '@mndw/sdk/angular';
import 'zone.js';
import '@angular/compiler';

import {AppComponent} from './app.component';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  return createAngularPluginInstance(el, {
    rootComponent: AppComponent,
    providers: [provideTranslator(ctx.i18n)],
    configure: ({component}) => {
      component.setInput('deviceName', ctx.hostInfo.deviceName);
    },
  });
}
