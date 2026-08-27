// @vitest-environment happy-dom

import 'zone.js';
import '@angular/compiler';
import {Component, inject} from '@angular/core';
import {TestBed, getTestBed} from '@angular/core/testing';
import {BrowserTestingModule, platformBrowserTesting} from '@angular/platform-browser/testing';
import {afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createTestI18n} from '../testing/i18n.js';
import {TRANSLATOR, provideTranslator} from './provide-translator.js';

@Component({selector: 'probe-cmp', standalone: true, template: '{{ translator.t("greeting") }}'})
class ProbeComponent {
  protected readonly translator = inject(TRANSLATOR);
}

describe('provideTranslator', () => {
  beforeAll(() => {
    getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    TestBed.configureTestingModule({providers: [provideTranslator(createTestI18n({greeting: 'Hi'}))]});
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('exposes the token id mndw.TRANSLATOR', () => {
    expect(TRANSLATOR.toString()).toContain('mndw.TRANSLATOR');
  });

  it('provides a reactive Translator resolvable by the TRANSLATOR token', () => {
    const fixture = TestBed.createComponent(ProbeComponent);

    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Hi');
    fixture.destroy();
  });
});
