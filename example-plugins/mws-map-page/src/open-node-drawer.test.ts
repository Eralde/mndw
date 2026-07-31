import '@angular/compiler';
import {
  type ApplicationRef,
  EnvironmentInjector,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import type {OverlayLayer, OverlayOpenOptions, PluginContext} from '@mndw/sdk';
import {Observable} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import drawerStyles from './components/node-drawer/node-drawer.component.scss?raw';
import drawerTemplate from './components/node-drawer/node-drawer.component.html?raw';
import type {MwsNode} from './domain/mws/mws.types';
import type {NodeDetailsSource} from './node-details-source';
import {openNodeDrawer} from './open-node-drawer';

describe('openNodeDrawer', () => {
  it('mounts, passes the layer signal to the source, and cleans up the Angular view', async () => {
    await resolveComponentResources((url: string) => {
      if (url.endsWith('node-drawer.component.html')) {
        return Promise.resolve(drawerTemplate);
      }

      if (url.endsWith('node-drawer.component.scss')) {
        return Promise.resolve(drawerStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    TestBed.configureTestingModule({});

    const attachView = vi.fn();
    const detachView = vi.fn();
    const appRef = {attachView, detachView} as unknown as ApplicationRef;
    const injector = TestBed.inject(EnvironmentInjector);
    const teardown = vi.fn();
    let sourceCompleted = false;
    const sourceOpen = vi.fn((_nodeId: string, signal: AbortSignal) =>
      new Observable<MwsNode | null>((subscriber) => {
        signal.addEventListener('abort', () => {
          sourceCompleted = true;
          subscriber.complete();
        }, {once: true});

        return teardown;
      })
    );
    const source: NodeDetailsSource = {open: sourceOpen};
    const onClose = vi.fn();
    const open = vi.fn(() => ({onClose}));
    const ctx = {overlay: {open}} as unknown as PluginContext;

    openNodeDrawer(ctx, appRef, injector, source, 'node-id', 'Node');

    expect(onClose).toHaveBeenCalledOnce();

    const options = open.mock.calls[0][0] as OverlayOpenOptions;
    const abortController = new AbortController();
    let cleanup: (() => void) | undefined;
    const layer = {
      signal: abortController.signal,
      setCleanup: (value: () => void) => {
        cleanup = value;
      },
    } as unknown as OverlayLayer;

    options.mount(document.createElement('div'), layer, abortController.signal);

    expect(sourceOpen).toHaveBeenCalledWith('node-id', abortController.signal);
    expect(attachView).toHaveBeenCalledOnce();

    abortController.abort();
    expect(sourceCompleted).toBe(true);

    cleanup?.();
    expect(teardown).toHaveBeenCalledOnce();
    expect(detachView).toHaveBeenCalledOnce();
  });
});
