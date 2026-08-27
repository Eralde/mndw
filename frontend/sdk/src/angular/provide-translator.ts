import {DestroyRef, InjectionToken, type Provider, inject} from '@angular/core';
import type {PluginI18n} from '../i18n.js';
import type {Translator} from '../translator.js';
import {createTranslatorSignals} from './create-translator-signals.js';

export const TRANSLATOR = new InjectionToken<Translator>('mndw.TRANSLATOR');

export const provideTranslator = (i18n: PluginI18n): Provider => ({
  provide: TRANSLATOR,
  useFactory: () => createTranslatorSignals(i18n, inject(DestroyRef)),
});
