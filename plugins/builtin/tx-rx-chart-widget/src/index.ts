import 'zone.js';
import '@angular/compiler';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createAngularPluginInstance, provideTranslator} from '@mndw/sdk/angular';
import {AppComponent} from './app/app.component';
import {type SettingsDialogArgs, openSettingsDialog} from './open-settings-dialog';
import {PLUGIN_STORAGE, RCI_MANAGER} from './tokens';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  return createAngularPluginInstance(el, {
    rootComponent: AppComponent,
    providers: [
      {provide: RCI_MANAGER, useValue: ctx.rciManager},
      {provide: PLUGIN_STORAGE, useValue: ctx.storage},
      provideTranslator(ctx.i18n),
    ],
    configure: ({appRef, component}) => {
      component.setInput(
        'openSettings',
        (args: SettingsDialogArgs) => openSettingsDialog(ctx, appRef, args),
      );
      component.setInput('setTileTitle', ctx.kind === 'widget' ? ctx.setTileTitle : undefined);
    },
    onUnmount: () => ctx.overlay.closeAll(),
  });
}
