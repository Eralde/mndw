// @vitest-environment happy-dom

import 'zone.js';
import '@angular/compiler';
import {ApplicationRef, Component} from '@angular/core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createAngularPluginInstance} from './mount-plugin-instance.js';

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

  it('mounts the root component into el', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const instance = createAngularPluginInstance(el, {rootComponent: RootComponent, providers: []});

    await flush();
    expect(el.textContent).toContain('mounted');
    void instance.unmount();
  });

  it('unmount empties el synchronously after mount', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const instance = createAngularPluginInstance(el, {rootComponent: RootComponent, providers: []});

    await flush();

    const result = instance.unmount();

    expect(result).toBeUndefined();
    expect(el.childNodes.length).toBe(0);
  });

  it('runs onUnmount exactly once', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const onUnmount = vi.fn();
    const instance = createAngularPluginInstance(el, {rootComponent: RootComponent, providers: [], onUnmount});

    await flush();
    void instance.unmount();
    void instance.unmount();
    expect(onUnmount).toHaveBeenCalledOnce();
  });

  it('completes teardown when onUnmount throws', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const instance = createAngularPluginInstance(el, {
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
    const instance = createAngularPluginInstance(el, {
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
    const instance = createAngularPluginInstance(el, {
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

  it('cancels a mount when unmounted before createApplication resolves', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const onUnmount = vi.fn();
    const destroySpy = vi.spyOn(ApplicationRef.prototype, 'destroy');
    const instance = createAngularPluginInstance(el, {rootComponent: RootComponent, providers: [], onUnmount});

    void instance.unmount();
    await flush();
    expect(onUnmount).toHaveBeenCalledOnce();
    expect(destroySpy).toHaveBeenCalledOnce();
    expect(el.textContent).not.toContain('mounted');
  });

  it('runs onUnmount and logs when mounting fails', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onUnmount = vi.fn();

    createAngularPluginInstance(el, {
      rootComponent: ThrowingRootComponent,
      providers: [],
      onUnmount,
    });
    await flush();
    expect(onUnmount).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith('[mndw] Angular plugin mount failed:', expect.any(Error));
    expect(el.childNodes.length).toBe(0);
  });
});
