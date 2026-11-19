// @vitest-environment happy-dom

import 'zone.js';
import '@angular/compiler';
import {ApplicationRef, Component} from '@angular/core';
import {createApplication} from '@angular/platform-browser';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createAngularPluginInstance} from './mount-plugin-instance.js';

vi.mock('@angular/platform-browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@angular/platform-browser')>();

  return {...actual, createApplication: vi.fn(actual.createApplication)};
});

@Component({selector: 'root-probe', standalone: true, template: '<span>mounted</span>'})
class RootComponent {}

@Component({selector: 'throwing-root', standalone: true, template: ''})
class ThrowingRootComponent {
  constructor() {
    throw new Error('component-fail');
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// eslint-disable-next-line max-lines-per-function -- root mount, cancellation, and teardown cases share one harness.
describe('createAngularPluginInstance', () => {
  let el: HTMLElement | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    el?.remove();
  });

  it('resolves after mounting the root component into el', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const instance = await createAngularPluginInstance(el, {rootComponent: RootComponent, providers: []});

    expect(el.textContent).toContain('mounted');
    void instance.unmount();
  });

  it('unmount empties el synchronously after mount', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const instance = await createAngularPluginInstance(el, {rootComponent: RootComponent, providers: []});

    await flush();

    const result = instance.unmount();

    expect(result).toBeUndefined();
    expect(el.childNodes.length).toBe(0);
  });

  it('runs onUnmount exactly once', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const onUnmount = vi.fn();
    const instance = await createAngularPluginInstance(el, {rootComponent: RootComponent, providers: [], onUnmount});

    await flush();
    void instance.unmount();
    void instance.unmount();
    expect(onUnmount).toHaveBeenCalledOnce();
  });

  it('completes teardown when onUnmount throws', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const instance = await createAngularPluginInstance(el, {
      rootComponent: RootComponent,
      providers: [],
      onUnmount: () => {
        throw new Error('boom');
      },
    });

    await flush();
    expect(() => instance.unmount()).toThrow('boom');
    expect(el.childNodes.length).toBe(0);
  });

  it('destroys the application and clears el when component destruction throws', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const componentError = new Error('component-destroy-fail');
    let appDestroyed = false;
    const instance = await createAngularPluginInstance(el, {
      rootComponent: RootComponent,
      providers: [],
      configure: ({appRef, component}) => {
        const destroyApp = appRef.destroy.bind(appRef);

        vi.spyOn(appRef, 'destroy').mockImplementation(() => {
          appDestroyed = true;
          destroyApp();
        });
        vi.spyOn(component, 'destroy').mockImplementation(() => {
          throw componentError;
        });
      },
    });

    await flush();
    expect(() => instance.unmount()).toThrow(componentError);
    expect(appDestroyed).toBe(true);
    expect(el.childNodes.length).toBe(0);
  });

  it('clears el when application destruction throws', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const appError = new Error('app-destroy-fail');
    const instance = await createAngularPluginInstance(el, {
      rootComponent: RootComponent,
      providers: [],
      configure: ({appRef}) => {
        vi.spyOn(appRef, 'destroy').mockImplementation(() => {
          throw appError;
        });
      },
    });

    await flush();
    expect(() => instance.unmount()).toThrow(appError);
    expect(el.childNodes.length).toBe(0);
  });

  it('rejects the original application creation error after cleanup', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const onUnmount = vi.fn();
    const appError = new Error('application-fail');

    vi.mocked(createApplication).mockRejectedValueOnce(appError);

    await expect(createAngularPluginInstance(el, {rootComponent: RootComponent, providers: [], onUnmount})).rejects
      .toBe(
        appError,
      );
    expect(onUnmount).toHaveBeenCalledOnce();
    expect(el.childNodes.length).toBe(0);
  });

  it('rejects component creation errors after destroying the application and clearing el', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const onUnmount = vi.fn();
    const appDestroySpy = vi.spyOn(ApplicationRef.prototype, 'destroy');

    await expect(createAngularPluginInstance(el, {
      rootComponent: ThrowingRootComponent,
      providers: [],
      onUnmount,
    })).rejects.toThrow('component-fail');
    expect(onUnmount).toHaveBeenCalledOnce();
    expect(appDestroySpy).toHaveBeenCalledOnce();
    expect(el.childNodes.length).toBe(0);
  });

  it('rejects configure errors after destroying the component and application', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const configureError = new Error('configure-fail');
    const onUnmount = vi.fn();
    const appDestroySpy = vi.spyOn(ApplicationRef.prototype, 'destroy');

    await expect(createAngularPluginInstance(el, {
      rootComponent: RootComponent,
      providers: [],
      configure: () => {
        throw configureError;
      },
      onUnmount,
    })).rejects.toBe(configureError);
    expect(onUnmount).toHaveBeenCalledOnce();
    expect(appDestroySpy).toHaveBeenCalledOnce();
    expect(el.childNodes.length).toBe(0);
  });

  it('rejects attachView errors after teardown without replacing the original error', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const attachError = new Error('attach-view-fail');
    const teardownError = new Error('teardown-fail');
    const onUnmount = vi.fn(() => {
      throw teardownError;
    });
    const attachViewSpy = vi.spyOn(ApplicationRef.prototype, 'attachView').mockImplementation(() => {
      throw attachError;
    });
    const appDestroySpy = vi.spyOn(ApplicationRef.prototype, 'destroy');

    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(createAngularPluginInstance(el, {
      rootComponent: RootComponent,
      providers: [],
      onUnmount,
    })).rejects.toBe(attachError);
    expect(attachViewSpy).toHaveBeenCalledOnce();
    expect(onUnmount).toHaveBeenCalledOnce();
    expect(appDestroySpy).toHaveBeenCalledOnce();
    expect(el.childNodes.length).toBe(0);
  });
});
