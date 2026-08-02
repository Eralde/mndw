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
  }

  globalThis.ResizeObserver = ResizeObserverStub;
}

if (globalThis.MutationObserver === undefined || typeof globalThis.MutationObserver.prototype.observe !== 'function') {
  class MutationObserverStub {
    public observe(): void {}

    public disconnect(): void {}
  }

  globalThis.MutationObserver = MutationObserverStub as typeof MutationObserver;
}
