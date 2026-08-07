import 'zone.js';
import 'zone.js/testing';
import {getTestBed} from '@angular/core/testing';
import {BrowserTestingModule, platformBrowserTesting} from '@angular/platform-browser/testing';
import {defineMndwUi} from '@mndw/ui';

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

defineMndwUi();

if (typeof MutationObserver !== 'undefined' && !('observe' in MutationObserver.prototype)) {
  class TestMutationObserver {
    public constructor(_callback: MutationCallback) {}

    public disconnect(): void {}

    public observe(_target: Node, _options?: MutationObserverInit): void {}

    public takeRecords(): MutationRecord[] {
      return [];
    }
  }

  globalThis.MutationObserver = TestMutationObserver;
}
