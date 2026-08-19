import 'zone.js';
import 'zone.js/testing';
import {getTestBed} from '@angular/core/testing';
import {BrowserTestingModule, platformBrowserTesting} from '@angular/platform-browser/testing';
import {defineMndwUi} from '@mndw/ui';

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

defineMndwUi();

if (globalThis.ResizeObserver === undefined) {
  class ResizeObserverStub {
    public observe(): void {}
    public disconnect(): void {}
    public unobserve(): void {}
  }

  globalThis.ResizeObserver = ResizeObserverStub;
}

if (globalThis.MutationObserver === undefined || typeof globalThis.MutationObserver.prototype.observe !== 'function') {
  class MutationObserverStub {
    constructor(_callback: MutationCallback) {}

    public observe(): void {}
    public disconnect(): void {}
    public takeRecords(): MutationRecord[] {
      return [];
    }
  }

  globalThis.MutationObserver = MutationObserverStub as typeof MutationObserver;
}
