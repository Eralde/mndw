import {type ApplicationRef, type ComponentRef, EnvironmentInjector, type Type, createComponent} from '@angular/core';
import type {OverlayLayer} from '../overlay.js';

export interface OverlayComponentMountOptions<C> {
  appRef: ApplicationRef;
  component: Type<C>;
  target: HTMLElement;
  layer: Pick<OverlayLayer, 'setCleanup'>;
  setup?: (ref: ComponentRef<C>) => void | (() => void);
}

export function mountComponentInOverlay<C>(options: OverlayComponentMountOptions<C>): ComponentRef<C> {
  const {appRef, component, target, layer, setup} = options;
  const injector = appRef.injector.get(EnvironmentInjector);

  let ref: ComponentRef<C> | undefined;
  let cleanup: (() => void) | undefined;

  try {
    ref = createComponent(component, {hostElement: target, environmentInjector: injector});

    const maybeCleanup = setup?.(ref);

    cleanup = typeof maybeCleanup === 'function' ? maybeCleanup : undefined;
    appRef.attachView(ref.hostView);
  } catch (err) {
    try {
      cleanup?.();
    } catch (cleanupErr) {
      console.error('[mndw] Angular overlay mount-failure cleanup failed:', cleanupErr);
    } finally {
      try {
        ref?.destroy();
      } catch (destroyErr) {
        console.error('[mndw] Angular overlay mount-failure destroy failed:', destroyErr);
      }
    }

    throw err;
  }

  const created = ref;

  layer.setCleanup(() => {
    try {
      cleanup?.();
    } finally {
      try {
        appRef.detachView(created.hostView);
      } finally {
        created.destroy();
      }
    }
  });

  return created;
}
