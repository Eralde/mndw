// @vitest-environment happy-dom

import 'zone.js';
import '@angular/compiler';
import {ApplicationRef, Component, type ComponentRef} from '@angular/core';
import {TestBed, getTestBed} from '@angular/core/testing';
import {BrowserTestingModule, platformBrowserTesting} from '@angular/platform-browser/testing';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {mountComponentInOverlay} from './mount-in-overlay.js';

@Component({selector: 'ov-probe', standalone: true, template: '<span>{{ label }}</span>'})
class ProbeComponent {
  public label = '';
}

const fakeLayer = () => {
  let cleanup: (() => void) | undefined;

  return {
    setCleanup: (fn: () => void) => {
      cleanup = fn;
    },
    runCleanup: () => cleanup?.(),
  };
};

// eslint-disable-next-line max-lines-per-function -- lifecycle ordering and failure cases share one Angular harness.
describe('mountComponentInOverlay', () => {
  let appRef: ApplicationRef;
  let target: HTMLElement;

  beforeAll(() => {
    getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    TestBed.configureTestingModule({});
    appRef = TestBed.inject(ApplicationRef);
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
    target.remove();
  });

  it('creates the component, runs setup, and attaches the view', () => {
    const attachSpy = vi.spyOn(appRef, 'attachView');
    const ref = mountComponentInOverlay({
      appRef,
      target,
      layer: fakeLayer(),
      component: ProbeComponent,
      setup: (created) => {
        created.instance.label = 'ok';
      },
    });

    ref.changeDetectorRef.detectChanges();
    expect(target.textContent).toContain('ok');
    expect(attachSpy).toHaveBeenCalledOnce();
    expect(attachSpy).toHaveBeenCalledWith(ref.hostView);
  });

  it('cleanup runs user cleanup then detachView then destroy, in order', () => {
    const detachSpy = vi.spyOn(appRef, 'detachView');
    const calls: string[] = [];
    const layer = fakeLayer();
    const ref = mountComponentInOverlay({
      appRef,
      target,
      layer,
      component: ProbeComponent,
      setup: () => () => calls.push('user'),
    });

    detachSpy.mockImplementation(() => calls.push('detach'));

    const destroySpy = vi.spyOn(ref, 'destroy').mockImplementation(() => calls.push('destroy'));

    layer.runCleanup();
    expect(calls).toEqual(['user', 'detach', 'destroy']);
    expect(destroySpy).toHaveBeenCalledOnce();
  });

  it('registered cleanup is throw-safe when user cleanup throws', () => {
    const detachSpy = vi.spyOn(appRef, 'detachView');
    const layer = fakeLayer();
    const ref = mountComponentInOverlay({
      appRef,
      target,
      layer,
      component: ProbeComponent,
      setup: () => () => {
        throw new Error('boom');
      },
    });
    const destroySpy = vi.spyOn(ref, 'destroy');

    expect(() => layer.runCleanup()).toThrow('boom');
    expect(detachSpy).toHaveBeenCalledWith(ref.hostView);
    expect(destroySpy).toHaveBeenCalledOnce();
  });

  it('registered cleanup destroys even when detachView throws', () => {
    const detachError = new Error('detach-fail');

    vi.spyOn(appRef, 'detachView').mockImplementation(() => {
      throw detachError;
    });

    const layer = fakeLayer();
    const ref = mountComponentInOverlay({appRef, target, layer, component: ProbeComponent});
    const destroySpy = vi.spyOn(ref, 'destroy');

    expect(() => layer.runCleanup()).toThrow(detachError);
    expect(destroySpy).toHaveBeenCalledOnce();
  });

  it('destroys the component and rethrows when setup fails before attach', () => {
    const attachSpy = vi.spyOn(appRef, 'attachView');

    expect(() =>
      mountComponentInOverlay({
        appRef,
        target,
        layer: fakeLayer(),
        component: ProbeComponent,
        setup: () => {
          throw new Error('setup-fail');
        },
      })
    ).toThrow('setup-fail');
    expect(attachSpy).not.toHaveBeenCalled();
  });

  it('preserves the attach error when failure cleanup also throws', () => {
    const attachError = new Error('attach-fail');
    const cleanupError = new Error('cleanup-fail');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.spyOn(appRef, 'attachView').mockImplementation(() => {
      throw attachError;
    });

    let created: ComponentRef<ProbeComponent> | undefined;

    expect(() =>
      mountComponentInOverlay({
        appRef,
        target,
        layer: fakeLayer(),
        component: ProbeComponent,
        setup: (ref) => {
          created = ref;

          return () => {
            throw cleanupError;
          };
        },
      })
    ).toThrow(attachError);
    expect(created?.hostView.destroyed).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      '[mndw] Angular overlay mount-failure cleanup failed:',
      cleanupError,
    );
  });
});
