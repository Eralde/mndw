// @vitest-environment happy-dom

import 'zone.js';
import '@angular/compiler';
import {createApplication} from '@angular/platform-browser';
import {Component, createComponent, DestroyRef, inject, InjectionToken} from '@angular/core';
import {createTestI18n} from '@mndw/sdk/testing';
import type {Translator} from '@mndw/sdk';
import {describe, expect, it} from 'vitest';
import {createTranslatorSignals} from '@mndw/sdk/angular';

const TRANSLATOR = new InjectionToken<Translator>('ANGULAR_PROBE_TRANSLATOR');

@Component({
  standalone: true,
  template: '<span data-testid="l10n-probe">{{ translator.t("l10n.probe") }}</span>',
})
class ProbeComponent {
  public readonly translator = inject(TRANSLATOR);
}

async function stabilize(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('Angular i18n createApplication path', () => {
  it('repaints the same node after a signal-driven locale change', async () => {
    const i18n = createTestI18n({l10n: {probe: 'English probe'}}, 'en');
    const host = document.createElement('div');
    const application = await createApplication({
      providers: [{
        provide: TRANSLATOR,
        useFactory: () => createTranslatorSignals(i18n, inject(DestroyRef)),
      }],
    });
    const component = createComponent(ProbeComponent, {
      hostElement: host,
      environmentInjector: application.injector,
    });

    application.attachView(component.hostView);
    await stabilize();

    const node = host.querySelector('[data-testid="l10n-probe"]');
    const enValue = i18n.t('l10n.probe');
    const ruValue = 'Русский probe';

    expect(enValue).not.toBe(ruValue);
    expect(node?.textContent).toBe(enValue);
    i18n.setLocale('ru', {l10n: {probe: ruValue}});
    await stabilize();

    expect(host.querySelector('[data-testid="l10n-probe"]')).toBe(node);
    expect(node?.textContent).toBe(ruValue);

    component.destroy();
    application.destroy();
  });
});
