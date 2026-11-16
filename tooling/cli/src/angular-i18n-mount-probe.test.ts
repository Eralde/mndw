// @vitest-environment happy-dom

import 'zone.js';
import '@angular/compiler';
import {createApplication} from '@angular/platform-browser';
import {Component, DestroyRef, InjectionToken, createComponent, inject} from '@angular/core';
import {createTestI18n} from '@mndw/sdk/testing';
import type {Translator} from '@mndw/sdk';
import {describe, expect, it} from 'vitest';
import {createTranslatorSignals} from '@mndw/sdk/angular';

const TRANSLATOR = new InjectionToken<Translator>('ANGULAR_TRANSLATOR');

@Component({
  standalone: true,
  template: '<button>{{ translator.t("action.run") }}</button>',
})
class LocalizedActionComponent {
  public readonly translator = inject(TRANSLATOR);
}

async function stabilize(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('Angular i18n createApplication path', () => {
  it('updates a visible action after a signal-driven locale change', async () => {
    const i18n = createTestI18n({action: {run: 'Run in English'}}, 'en');
    const host = document.createElement('div');
    const application = await createApplication({
      providers: [{
        provide: TRANSLATOR,
        useFactory: () => createTranslatorSignals(i18n, inject(DestroyRef)),
      }],
    });
    const component = createComponent(LocalizedActionComponent, {
      hostElement: host,
      environmentInjector: application.injector,
    });

    application.attachView(component.hostView);
    await stabilize();

    const button = host.querySelector('button');
    const enValue = i18n.t('action.run');
    const ruValue = 'Запустить';

    expect(enValue).not.toBe(ruValue);
    expect(button?.textContent).toBe(enValue);
    i18n.setLocale('ru', {action: {run: ruValue}});
    await stabilize();

    expect(host.querySelector('button')).toBe(button);
    expect(button?.textContent).toBe(ruValue);

    component.destroy();
    application.destroy();
  });
});
