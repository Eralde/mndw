import {
  type ApplicationRef,
  type ComponentRef,
  EnvironmentInjector,
  type Provider,
  type Type,
  createComponent,
} from '@angular/core';
import {createApplication} from '@angular/platform-browser';
import type {PluginInstance} from '../plugin.js';

export interface AngularPluginInstanceOptions {
  rootComponent: Type<unknown>;
  providers: Provider[];
  configure?: (mounted: {
    appRef: ApplicationRef;
    injector: EnvironmentInjector;
    component: ComponentRef<unknown>;
  }) => void;
  onUnmount?: () => void;
}

const runTeardown = (actions: Array<() => void>): void => {
  let firstError: unknown;
  let failed = false;

  for (const action of actions) {
    try {
      action();
    } catch (err) {
      if (!failed) {
        firstError = err;
        failed = true;
      } else {
        console.error('[mndw] Angular plugin secondary teardown failed:', err);
      }
    }
  }

  if (failed) {
    throw firstError;
  }
};

export function createAngularPluginInstance(
  el: HTMLElement,
  options: AngularPluginInstanceOptions,
): PluginInstance {
  let appRef: ApplicationRef | null = null;
  let component: ComponentRef<unknown> | null = null;
  let disposed = false;

  const teardown = (): void => {
    try {
      runTeardown([
        () => options.onUnmount?.(),
        () => component?.destroy(),
        () => appRef?.destroy(),
        () => el.replaceChildren(),
      ]);
    } finally {
      component = null;
      appRef = null;
    }
  };

  createApplication({providers: options.providers})
    .then((ref) => {
      if (disposed) {
        ref.destroy();

        return;
      }

      appRef = ref;

      const injector = ref.injector.get(EnvironmentInjector);

      el.innerHTML = '';
      component = createComponent(options.rootComponent, {hostElement: el, environmentInjector: injector});
      options.configure?.({appRef: ref, injector, component});
      ref.attachView(component.hostView);
    })
    .catch((err: unknown) => {
      if (disposed) {
        return;
      }

      disposed = true;
      console.error('[mndw] Angular plugin mount failed:', err);

      try {
        teardown();
      } catch (teardownErr) {
        console.error('[mndw] Angular plugin mount-failure teardown failed:', teardownErr);
      }
    });

  return {
    unmount(): void {
      if (disposed) {
        return;
      }

      disposed = true;
      teardown();
    },
  };
}
