import '@angular/compiler';
import {
  ApplicationRef,
  EnvironmentInjector,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import type {OverlayLayer, OverlayOpenOptions, PluginContext} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import {Observable, Subject, of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import drawerStyles from './components/node-drawer/node-drawer.component.scss?raw';
import drawerTemplate from './components/node-drawer/node-drawer.component.html?raw';
import type {MwsNode} from './domain/mws/mws.types';
import type {NodeDetailsSource} from './node-details-source';
import {openNodeDrawer} from './open-node-drawer';
import {MwsDataService} from './services/mws-data.service';
import {MwsWriteService} from './services/mws-write.service';
import {MWS_RENAME_API, TRANSLATOR} from './tokens';
import enCatalog from '../i18n/en.json';

describe('openNodeDrawer', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

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
    TestBed.configureTestingModule({
      providers: [
        {provide: MWS_RENAME_API, useValue: {renameNode: vi.fn(() => of(undefined))}},
        {provide: MwsDataService, useValue: {refreshNow: vi.fn()}},
        {provide: MwsWriteService, useValue: {setPower: vi.fn()}},
        {provide: TRANSLATOR, useValue: createTestI18n(enCatalog)},
      ],
    });

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

  it('updates the returned overlay session title after a drawer rename', async () => {
    await resolveComponentResources((url: string) => {
      if (url.endsWith('node-drawer.component.html')) {
        return Promise.resolve(drawerTemplate);
      }

      if (url.endsWith('node-drawer.component.scss')) {
        return Promise.resolve(drawerStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    TestBed.configureTestingModule({
      providers: [
        {provide: MWS_RENAME_API, useValue: {renameNode: vi.fn(() => of(undefined))}},
        {provide: MwsDataService, useValue: {refreshNow: vi.fn()}},
        {provide: MwsWriteService, useValue: {setPower: vi.fn()}},
        {provide: TRANSLATOR, useValue: createTestI18n(enCatalog)},
      ],
    });

    const appRef = TestBed.inject(ApplicationRef);
    const injector = TestBed.inject(EnvironmentInjector);
    const target = document.createElement('div');
    const update = vi.fn();
    const onClose = vi.fn();
    const open = vi.fn(() => ({onClose, update}));
    const ctx = {overlay: {open}} as unknown as PluginContext;
    const source: NodeDetailsSource = {
      open: () =>
        of({
          id: '02:7d:4a:91:c3:10',
          cid: null,
          name: 'Router',
          model: null,
          ip: null,
          mac: '02:7d:4a:91:c3:10',
          isController: true,
          isOnline: true,
          fw: null,
          fwAvailable: null,
          system: null,
          backhaul: null,
          parent: null,
          children: [],
          clients: [],
          dualBand: false,
        }),
    };

    openNodeDrawer(ctx, appRef, injector, source, '02:7d:4a:91:c3:10', 'Router');

    const options = open.mock.calls[0][0] as OverlayOpenOptions;
    const abortController = new AbortController();
    const layer = {
      signal: abortController.signal,
      setCleanup: vi.fn(),
    } as unknown as OverlayLayer;

    options.mount(target, layer, abortController.signal);
    appRef.tick();
    target.querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    appRef.tick();

    const input = target.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = 'Renamed Router';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    target.querySelector<HTMLElement>('[data-action="save-name"]')?.click();
    appRef.tick();

    expect(update).toHaveBeenCalledWith({title: 'Renamed Router'});
  });

  it('updates the overlay title when a later node snapshot changes the name', async () => {
    await resolveComponentResources((url: string) => {
      if (url.endsWith('node-drawer.component.html')) {
        return Promise.resolve(drawerTemplate);
      }

      if (url.endsWith('node-drawer.component.scss')) {
        return Promise.resolve(drawerStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    TestBed.configureTestingModule({
      providers: [
        {provide: MWS_RENAME_API, useValue: {renameNode: vi.fn(() => of(undefined))}},
        {provide: MwsDataService, useValue: {refreshNow: vi.fn()}},
        {provide: MwsWriteService, useValue: {setPower: vi.fn()}},
        {provide: TRANSLATOR, useValue: createTestI18n(enCatalog)},
      ],
    });

    const appRef = TestBed.inject(ApplicationRef);
    const injector = TestBed.inject(EnvironmentInjector);
    const target = document.createElement('div');
    const update = vi.fn();
    const onClose = vi.fn();
    const snapshots = new Subject<MwsNode | null>();
    const open = vi.fn(() => ({onClose, update}));
    const ctx = {overlay: {open}} as unknown as PluginContext;
    const source: NodeDetailsSource = {open: () => snapshots};

    openNodeDrawer(ctx, appRef, injector, source, 'node-id', 'Router');

    const options = open.mock.calls[0][0] as OverlayOpenOptions;
    const abortController = new AbortController();
    const layer = {signal: abortController.signal, setCleanup: vi.fn()} as unknown as OverlayLayer;

    options.mount(target, layer, abortController.signal);
    snapshots.next({
      id: 'node-id',
      cid: null,
      name: 'Router',
      model: null,
      ip: null,
      mac: '02:7d:4a:91:c3:10',
      isController: true,
      isOnline: true,
      fw: null,
      fwAvailable: null,
      system: null,
      backhaul: null,
      parent: null,
      children: [],
      clients: [],
      dualBand: false,
    });
    snapshots.next({
      id: 'node-id',
      cid: null,
      name: 'Externally renamed',
      model: null,
      ip: null,
      mac: '02:7d:4a:91:c3:10',
      isController: true,
      isOnline: true,
      fw: null,
      fwAvailable: null,
      system: null,
      backhaul: null,
      parent: null,
      children: [],
      clients: [],
      dualBand: false,
    });
    appRef.tick();

    expect(update).toHaveBeenCalledWith({title: 'Externally renamed'});
  });
});
