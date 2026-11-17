import {reflectComponentType} from '@angular/core';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createAngularPluginInstance, provideTranslator} from '@mndw/sdk/angular';
import {bindLocale} from '@mndw/sdk/bind-locale';
import 'zone.js';
import '@angular/compiler';

import {AppComponent, PLUGIN_CONTEXT} from './app.component';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  const instance = createAngularPluginInstance(el, {
    rootComponent: AppComponent,
    providers: [provideTranslator(ctx.i18n), {provide: PLUGIN_CONTEXT, useValue: ctx}],
    configure: ({component}) => {
      if (
        reflectComponentType(component.componentType)?.inputs.some(({templateName}) => templateName === 'deviceName')
      ) {
        component.setInput('deviceName', ctx.deviceInfo.deviceName);
      }
    },
  });
  const unsubscribeLocale = bindLocale(ctx.i18n, () => {
    if (ctx.kind === 'widget') {
      ctx.setTileTitle?.(ctx.i18n.t('l10n.title'));
    }
  });

  return {
    async unmount(): Promise<void> {
      unsubscribeLocale();
      await instance.unmount();
    },
  };
}
