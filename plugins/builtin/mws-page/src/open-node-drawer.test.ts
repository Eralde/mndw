import type {OverlayLayer, OverlayOpenOptions, PluginContext} from '@mndw/sdk';
import {Subject} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {NodeDrawerComponent} from './components/node-drawer/node-drawer.component';
import type {MwsNode} from './domain/mws/mws.types';
import type {NodeDetailsSource} from './node-details-source';
import {openNodeDrawer} from './open-node-drawer';

const mountComponentInOverlay = vi.hoisted(() => vi.fn());

vi.mock('@mndw/sdk/angular', () => ({mountComponentInOverlay}));

const makeNode = (name: string): MwsNode => ({
  id: 'node-1',
  cid: null,
  name,
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

const mountOptions = (open: ReturnType<typeof vi.fn>): OverlayOpenOptions => {
  return open.mock.calls[0][0] as OverlayOpenOptions;
};

const fakeLayer = (): OverlayLayer => {
  return {
    signal: new AbortController().signal,
    setCleanup: vi.fn(),
    close: vi.fn(),
  } as unknown as OverlayLayer;
};

const context = (open: ReturnType<typeof vi.fn>): PluginContext => {
  return {overlay: {open}} as unknown as PluginContext;
};

describe('openNodeDrawer', () => {
  beforeEach(() => mountComponentInOverlay.mockReset());

  it('opens a drawer and delegates Angular mounting to the SDK helper', () => {
    const open = vi.fn(() => ({onClose: vi.fn()}));
    const ctx = context(open);
    const appRef = {} as never;
    const source: NodeDetailsSource = {open: vi.fn(() => new Subject<MwsNode | null>())};

    openNodeDrawer(ctx, appRef, source, 'node-1', 'Mesh node');

    const openOpts = mountOptions(open);

    expect(openOpts.kind).toBe('drawer');
    expect(openOpts.title).toBe('Mesh node');

    const target = document.createElement('div');
    const layer = fakeLayer();

    openOpts.mount(target, layer, layer.signal);

    expect(mountComponentInOverlay).toHaveBeenCalledOnce();

    const helperArgs = mountComponentInOverlay.mock.calls[0][0];

    expect(helperArgs.appRef).toBe(appRef);
    expect(helperArgs.target).toBe(target);
    expect(helperArgs.layer).toBe(layer);
    expect(helperArgs.component).toBe(NodeDrawerComponent);
    expect(typeof helperArgs.setup).toBe('function');
  });

  it('uses the localized generic title supplied by the app', () => {
    const open = vi.fn(() => ({onClose: vi.fn()}));
    const ctx = context(open);
    const source: NodeDetailsSource = {open: vi.fn(() => new Subject<MwsNode | null>())};

    openNodeDrawer(ctx, {} as never, source, 'node-1', 'Узел сети');

    expect(mountOptions(open).title).toBe('Узел сети');
  });

  it('setup subscribes with the layer signal and returns an unsubscribe', () => {
    const open = vi.fn(() => ({onClose: vi.fn()}));
    const ctx = context(open);
    const subject = new Subject<MwsNode | null>();
    const sourceOpen = vi.fn(() => subject);
    const source: NodeDetailsSource = {open: sourceOpen};
    const setInput = vi.fn();

    openNodeDrawer(ctx, {} as never, source, 'node-1', 'Mesh node');

    const openOpts = mountOptions(open);
    const layer = fakeLayer();

    openOpts.mount(document.createElement('div'), layer, layer.signal);

    const {setup} = mountComponentInOverlay.mock.calls[0][0];
    const cleanup = setup({setInput, instance: {}});

    expect(sourceOpen).toHaveBeenCalledWith('node-1', layer.signal);
    expect(subject.observed).toBe(true);
    cleanup();
    expect(subject.observed).toBe(false);
  });

  it('keeps the generic overlay title when a later node snapshot changes the name', () => {
    const update = vi.fn();
    const open = vi.fn(() => ({onClose: vi.fn(), update}));
    const ctx = context(open);
    const snapshots = new Subject<MwsNode | null>();
    const source: NodeDetailsSource = {open: vi.fn(() => snapshots)};
    const setInput = vi.fn();

    openNodeDrawer(ctx, {} as never, source, 'node-1', 'Mesh node');

    const openOpts = mountOptions(open);
    const layer = fakeLayer();

    openOpts.mount(document.createElement('div'), layer, layer.signal);

    const {setup} = mountComponentInOverlay.mock.calls[0][0];

    setup({setInput, instance: {}});

    const renamed = makeNode('Externally renamed');

    snapshots.next(renamed);

    expect(setInput).toHaveBeenCalledWith('node', renamed);
    expect(update).not.toHaveBeenCalled();
    expect(openOpts.title).toBe('Mesh node');
    expect(setInput.mock.calls.some(([name]) => name === 'setTitle')).toBe(false);
  });
});
