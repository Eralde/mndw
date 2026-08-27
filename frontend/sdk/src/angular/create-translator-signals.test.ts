// @vitest-environment happy-dom

import 'zone.js';
import '@angular/compiler';
import {Component, DestroyRef, InjectionToken, inject} from '@angular/core';
import {TestBed, getTestBed} from '@angular/core/testing';
import {BrowserTestingModule, platformBrowserTesting} from '@angular/platform-browser/testing';
import {beforeAll, describe, expect, it} from 'vitest';
import {createTestI18n} from '../testing/i18n.js';
import type {Translator} from '../translator.js';
import {createTranslatorSignals} from './create-translator-signals.js';

const TRANSLATOR = new InjectionToken<Translator>('TEST_TRANSLATOR');

@Component({
  standalone: true,
  template: '<span data-testid="probe">{{ translator.t("message") }}</span>',
})
class ProbeComponent {
  public readonly translator = inject(TRANSLATOR);
}

describe('createTranslatorSignals', () => {
  beforeAll(() => {
    getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it('updates a TestBed fixture after locale changes without remounting', () => {
    const i18n = createTestI18n({message: 'Hello'}, 'en');

    TestBed.configureTestingModule({
      imports: [ProbeComponent],
      providers: [{provide: TRANSLATOR, useFactory: () => createTranslatorSignals(i18n, inject(DestroyRef))}],
    });

    const fixture = TestBed.createComponent(ProbeComponent);

    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const node = root.firstElementChild as HTMLElement;

    expect(node.textContent).toBe('Hello');
    i18n.setLocale('ru', {message: 'Привет'});
    fixture.detectChanges();

    expect(root.firstElementChild).toBe(node);
    expect(node.textContent).toBe('Привет');
    fixture.destroy();
  });
});
